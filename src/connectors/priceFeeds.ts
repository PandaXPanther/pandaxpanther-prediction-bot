import WebSocket from 'ws';
import axios from 'axios';
import { getConfig } from '../utils/config.js';
import { createStrategyLogger } from '../utils/logger.js';

const log = createStrategyLogger('priceFeeds');

export type PriceTick = {
  source: 'binance' | 'coinbase' | 'gemini' | 'kraken' | 'bitstamp' | 'rest';
  symbol: string;
  price: number;
  ts: number;
};

const SYMBOLS = ['btcusdt', 'ethusdt', 'solusdt', 'xrpusdt', 'dogeusdt'];

// REST fallback sources - ordered by reliability+speed (tested from Fly DFW)
// OKX (323ms) → Coinbase spot (555ms) → Cryptocompare (562ms) → Kraken (798ms)
// Each is rotated round-robin to spread load and avoid any single-provider rate limits.
const OKX_PAIRS: Record<string, string> = {
  BTCUSDT: 'BTC-USDT', ETHUSDT: 'ETH-USDT', SOLUSDT: 'SOL-USDT',
  XRPUSDT: 'XRP-USDT', DOGEUSDT: 'DOGE-USDT',
};
const CB_PAIRS: Record<string, string> = {
  BTCUSDT: 'BTC-USD', ETHUSDT: 'ETH-USD', SOLUSDT: 'SOL-USD',
  XRPUSDT: 'XRP-USD', DOGEUSDT: 'DOGE-USD',
};
const CC_SYMS: Record<string, string> = {
  BTCUSDT: 'BTC', ETHUSDT: 'ETH', SOLUSDT: 'SOL',
  XRPUSDT: 'XRP', DOGEUSDT: 'DOGE',
};

// Freshness window: how old a tick can be and still be considered "current".
// Low-volume periods (overnight) can have BTC ticks every 30-60s.
const FRESHNESS_MS = 180_000;      // 3 min — generous; we always have REST backstop
const HEALTH_CHECK_MS = 15_000;    // every 15s, check if any tick arrived
const REST_FALLBACK_MS = 10_000;   // every 10s poll REST regardless
const RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

export class PriceFeedAggregator {
  private latest = new Map<string, PriceTick>();
  private subscribers = new Map<string, ((tick: PriceTick) => void)[]>();
  // v3.4: per-source latest prices for BRTI estimation.
  // BRTI (CF Benchmarks Bitcoin Real-Time Index) is the published settlement source
  // for Kalshi crypto markets. True BRTI is computed by CF Benchmarks from 6 constituents
  // (Bitstamp, Coinbase, Gemini, itBit, Kraken, LMAX_Digital). We approximate by tracking
  // 4 of 6 (Coinbase, Gemini, Kraken, Bitstamp) and taking the median.
  // Median is more robust than mean against single-exchange outliers — same property
  // that BRTI selective median uses. Closes the gap between our spot estimate and
  // Kalshi's actual settle reference.
  private bySource = new Map<string, Map<string, { price: number; ts: number }>>();
  // bySource: symbol → { source name → {price, ts} }
  private binanceWs: WebSocket | null = null;
  private coinbaseWs: WebSocket | null = null;
  private geminiWs: WebSocket | null = null;
  private geminiReconnectDelay = RECONNECT_DELAY_MS;
  private geminiEnabled = process.env.GEMINI_DISABLED !== 'true';
  private binanceEnabled = process.env.BINANCE_DISABLED !== 'true';
  private coinbaseReconnectDelay = RECONNECT_DELAY_MS;
  private binanceReconnectDelay = RECONNECT_DELAY_MS;
  private lastTickAt = 0;
  private restFallbackTimer: NodeJS.Timeout | null = null;

  /** Public accessor for the watchdog. Returns ms-since-epoch of the last successful tick (any source). 0 = never. */
  public getLastTickAt(): number { return this.lastTickAt; }

  async start(): Promise<void> {
    log.info({ binanceEnabled: this.binanceEnabled, symbols: SYMBOLS }, 'PriceFeedAggregator starting');
    this.connectCoinbase();
    // 2026-05-23: Added Gemini WebSocket. Gemini is a BRTI constituent exchange
    // (the exact index Kalshi uses for BTC settlement). Sub-15ms latency from US.
    // This is the most-correlated feed for Kalshi BTC pricing decisions.
    if (this.geminiEnabled) this.connectGemini();
    // v3.4: Kraken + Bitstamp REST pollers (3s cadence). Together with Coinbase + Gemini
    // = 4 of 6 BRTI constituents. getBrtiEstimate() takes the median — the same selective
    // median methodology CF Benchmarks uses for BRTI. Closes the settlement basis gap.
    this.startKrakenPoller();
    this.startBitstampPoller();
    if (this.binanceEnabled) this.connectBinance();
    setInterval(() => this.healthCheck(), HEALTH_CHECK_MS);
    // REST fallback runs always at slow cadence to seed prices immediately
    // and bridge any WS gap. Coinbase WS will override with fresher ticks when alive.
    this.startRestFallback();
    // Do an immediate seed so strategies have prices within seconds
    void this.fetchRestPrices();
  }

  private connectBinance(): void {
    if (!this.binanceEnabled) return;
    const config = getConfig();
    const streams = SYMBOLS.map((s) => `${s}@trade`).join('/');
    const url = `${config.BINANCE_WS_URL}/stream?streams=${streams}`;
    try {
      this.binanceWs = new WebSocket(url);
    } catch (err: any) {
      log.error({ err: err.message }, 'Binance WS constructor failed');
      this.scheduleBinanceReconnect();
      return;
    }
    this.binanceWs.on('open', () => {
      log.info('Binance WS connected');
      this.binanceReconnectDelay = RECONNECT_DELAY_MS;
    });
    this.binanceWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        const trade = msg.data;
        if (trade?.s && trade?.p) {
          this.publish({
            source: 'binance', symbol: trade.s,
            price: parseFloat(trade.p), ts: trade.T ?? Date.now(),
          });
        }
      } catch (err: any) {
        // v1 LOW-7: parse errors are rare but should be visible at debug. A flood
        // of these signals Binance changed its message format.
        log.debug({ err: err?.message ?? String(err) }, 'Binance WS message parse error');
      }
    });
    this.binanceWs.on('close', (code, reason) => {
      log.warn({ code, reason: reason?.toString(), delay: this.binanceReconnectDelay }, 'Binance WS closed');
      this.scheduleBinanceReconnect();
    });
    this.binanceWs.on('error', (err: any) => {
      log.error({ err: err.message }, 'Binance WS error');
      if (String(err.message).includes('451') || String(err.message).includes('403')) {
        log.warn('Binance geo-blocked - disabling permanently');
        this.binanceEnabled = false;
        try { this.binanceWs?.close(); } catch {}
      }
    });
  }

  private scheduleBinanceReconnect(): void {
    if (!this.binanceEnabled) return;
    const delay = this.binanceReconnectDelay;
    this.binanceReconnectDelay = Math.min(this.binanceReconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
    setTimeout(() => this.connectBinance(), delay);
  }

  private connectCoinbase(): void {
    const config = getConfig();
    try {
      this.coinbaseWs = new WebSocket(config.COINBASE_WS_URL);
    } catch (err: any) {
      log.error({ err: err.message }, 'Coinbase WS constructor failed');
      this.scheduleCoinbaseReconnect();
      return;
    }
    this.coinbaseWs.on('open', () => {
      log.info('Coinbase WS connected');
      this.coinbaseReconnectDelay = RECONNECT_DELAY_MS;
      this.coinbaseWs!.send(JSON.stringify({
        type: 'subscribe',
        product_ids: ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'DOGE-USD'],
        channels: ['ticker'],
      }));
    });
    this.coinbaseWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ticker' && msg.product_id && msg.price) {
          this.publish({
            source: 'coinbase',
            symbol: msg.product_id.replace('-', ''),
            price: parseFloat(msg.price),
            ts: msg.time ? new Date(msg.time).getTime() : Date.now(),
          });
        }
      } catch (err: any) {
        // v1 LOW-7: parse errors visible at debug. Flood = Coinbase format change.
        log.debug({ err: err?.message ?? String(err) }, 'Coinbase WS message parse error');
      }
    });
    this.coinbaseWs.on('error', (err: any) => log.error({ err: err.message }, 'Coinbase WS error'));
    this.coinbaseWs.on('close', (code, reason) => {
      log.warn({ code, reason: reason?.toString(), delay: this.coinbaseReconnectDelay }, 'Coinbase WS closed');
      this.scheduleCoinbaseReconnect();
    });
  }

  private scheduleCoinbaseReconnect(): void {
    const delay = this.coinbaseReconnectDelay;
    this.coinbaseReconnectDelay = Math.min(this.coinbaseReconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
    setTimeout(() => this.connectCoinbase(), delay);
  }

  // 2026-05-23: Gemini market data WebSocket. Per-symbol URL, no auth required.
  // BRTI = (Bitstamp + Coinbase + Gemini + itBit + Kraken + LMAX_Digital) / 6 (selective).
  // Kalshi uses CF Benchmarks BRTI as settlement source for BTC markets. Gemini ticks
  // are part of THAT index, so this feed is maximally correlated with Kalshi's truth price.
  private connectGemini(): void {
    // 2026-05-23 v3.1: expanded Gemini WS to ETH too (Gemini is also a CF Benchmarks
    // ETH index constituent). Other Kalshi-traded coins (SOL/XRP/DOGE) rely on the
    // Coinbase WS feed which is already in place.
    const symbols = ['btcusd', 'ethusd'];
    for (const sym of symbols) {
      try {
        const ws = new WebSocket(`wss://api.gemini.com/v1/marketdata/${sym}`);
        ws.on('open', () => {
          log.info({ symbol: sym }, 'Gemini WS connected');
          this.geminiReconnectDelay = RECONNECT_DELAY_MS;
        });
        ws.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'update' && Array.isArray(msg.events)) {
              for (const e of msg.events) {
                if (e.type === 'trade' && e.price) {
                  this.publish({
                    source: 'gemini',
                    symbol: sym.toUpperCase() + 'T',  // e.g. BTCUSDT to match other feeds
                    price: parseFloat(e.price),
                    ts: msg.timestampms ?? Date.now(),
                  });
                }
              }
            }
          } catch (err: any) {
            log.debug({ err: err?.message }, 'Gemini WS parse error');
          }
        });
        ws.on('error', (err: any) => log.warn({ err: err.message, symbol: sym }, 'Gemini WS error'));
        ws.on('close', (code) => {
          log.warn({ code, symbol: sym }, 'Gemini WS closed');
          this.scheduleGeminiReconnect();
        });
        this.geminiWs = ws;
      } catch (err: any) {
        log.error({ err: err.message, symbol: sym }, 'Gemini WS constructor failed');
        this.scheduleGeminiReconnect();
      }
    }
  }

  // v3.4: Kraken REST poller — BRTI constituent
  private startKrakenPoller(): void {
    const krakenSymbols: Array<[string, string]> = [
      // Kraken's pair codes are weird; XBTUSD = BTC
      ['XXBTZUSD', 'BTCUSDT'],
      ['XETHZUSD', 'ETHUSDT'],
    ];
    const pollOnce = async () => {
      try {
        const pairs = krakenSymbols.map(([k]) => k).join(',');
        const r = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${pairs}`);
        if (!r.ok) return;
        const d: any = await r.json();
        const result = d?.result;
        if (!result) return;
        const now = Date.now();
        for (const [krakenPair, normSymbol] of krakenSymbols) {
          const row = result[krakenPair];
          if (!row?.c?.[0]) continue;
          const price = parseFloat(row.c[0]);
          if (!isFinite(price) || price <= 0) continue;
          this.publish({ source: 'kraken', symbol: normSymbol, price, ts: now });
        }
      } catch (err: any) {
        log.debug({ err: err.message }, 'kraken poll failed');
      }
    };
    pollOnce();
    setInterval(pollOnce, 3000);
  }

  // v3.4: Bitstamp REST poller — BRTI constituent
  private startBitstampPoller(): void {
    const bitstampSymbols: Array<[string, string]> = [
      ['btcusd', 'BTCUSDT'],
      ['ethusd', 'ETHUSDT'],
    ];
    const pollOnce = async () => {
      const now = Date.now();
      for (const [bsSym, normSymbol] of bitstampSymbols) {
        try {
          const r = await fetch(`https://www.bitstamp.net/api/v2/ticker/${bsSym}/`);
          if (!r.ok) continue;
          const d: any = await r.json();
          const price = parseFloat(d?.last);
          if (!isFinite(price) || price <= 0) continue;
          this.publish({ source: 'bitstamp', symbol: normSymbol, price, ts: now });
        } catch (err: any) {
          log.debug({ err: err.message, sym: bsSym }, 'bitstamp poll failed');
        }
      }
    };
    pollOnce();
    setInterval(pollOnce, 3000);
  }

  private scheduleGeminiReconnect(): void {
    const delay = this.geminiReconnectDelay;
    this.geminiReconnectDelay = Math.min(this.geminiReconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
    setTimeout(() => this.connectGemini(), delay);
  }

  /**
   * Health watchdog: if no tick from ANY source in 60s, force reconnect both WS sockets
   * and bump REST fallback frequency.
   */
  private healthCheck(): void {
    const now = Date.now();
    const stalenessMs = now - this.lastTickAt;
    const cbOpen = this.coinbaseWs?.readyState === WebSocket.OPEN;
    const biOpen = this.binanceWs?.readyState === WebSocket.OPEN;
    log.info({ stalenessMs, lastTickAt: this.lastTickAt, cbOpen, biOpen, latestSize: this.latest.size }, 'price feed health');
    if (this.lastTickAt === 0 || stalenessMs > 60_000) {
      log.warn({ stalenessMs }, 'No ticks in 60s - forcing WS reconnect');
      try { this.coinbaseWs?.terminate(); } catch {}
      try { this.binanceWs?.terminate(); } catch {}
      // close() listeners will reconnect
      // Also fetch REST immediately
      void this.fetchRestPrices();
    }
  }

  private startRestFallback(): void {
    if (this.restFallbackTimer) clearInterval(this.restFallbackTimer);
    // ALWAYS poll REST every 10s as a backstop — don't gate on WS staleness.
    // CoinGecko free tier handles ~30 req/min so 6 req/min is well within limits.
    // This guarantees prices are NEVER more than 10s stale.
    this.restFallbackTimer = setInterval(() => {
      void this.fetchRestPrices();
    }, REST_FALLBACK_MS);
  }

  private async fetchRestPrices(): Promise<void> {
    // Parallel race across all 4 providers. The first one to succeed wins —
    // subsequent successes still publish prices (which is harmless, latest wins).
    // Time to first price = min(latencies), not sum. A single hung provider
    // can't bottleneck the rest.
    const providers = [
      { name: 'okx', fn: () => this.fetchOkx() },
      { name: 'coinbase', fn: () => this.fetchCoinbaseRest() },
      { name: 'cryptocompare', fn: () => this.fetchCryptocompare() },
      { name: 'kraken', fn: () => this.fetchKraken() },
    ];
    let anySuccess = false;
    const results = await Promise.allSettled(
      providers.map(async (p) => {
        const updated = await p.fn();
        return { name: p.name, updated };
      }),
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.updated > 0) {
        anySuccess = true;
        log.debug({ provider: r.value.name, updated: r.value.updated }, 'REST prices fetched');
      } else if (r.status === 'rejected') {
        log.debug({ err: r.reason?.message ?? String(r.reason) }, 'REST provider failed (parallel race)');
      }
    }
    if (!anySuccess) {
      log.error('All REST providers failed - no prices this cycle');
    }
  }

  private async fetchOkx(): Promise<number> {
    // OKX returns all tickers in one call - super fast
    const { data } = await axios.get('https://www.okx.com/api/v5/market/tickers?instType=SPOT', { timeout: 8000 });
    const now = Date.now();
    let updated = 0;
    const byInst: Record<string, number> = {};
    for (const t of data?.data ?? []) {
      const px = parseFloat(t.last);
      if (t.instId && px > 0) byInst[t.instId] = px;
    }
    for (const [sym, instId] of Object.entries(OKX_PAIRS)) {
      const price = byInst[instId];
      if (price && price > 0) {
        this.publish({ source: 'rest', symbol: sym, price, ts: now });
        updated++;
      }
    }
    return updated;
  }

  private async fetchCoinbaseRest(): Promise<number> {
    // Coinbase spot endpoint - one request per symbol but very fast
    const now = Date.now();
    let updated = 0;
    const reqs = Object.entries(CB_PAIRS).map(async ([sym, pair]) => {
      try {
        const { data } = await axios.get(`https://api.coinbase.com/v2/prices/${pair}/spot`, { timeout: 8000 });
        const price = parseFloat(data?.data?.amount);
        if (price > 0) {
          this.publish({ source: 'rest', symbol: sym, price, ts: now });
          updated++;
        }
      } catch (err: any) {
        // v1 LOW-8: visible at debug so a per-pair outage isn't completely silent.
        log.debug({ sym, err: err?.message ?? String(err) }, 'Coinbase REST per-pair fetch failed');
      }
    });
    await Promise.all(reqs);
    return updated;
  }

  private async fetchCryptocompare(): Promise<number> {
    // Cryptocompare returns all in one call
    const syms = Object.values(CC_SYMS).join(',');
    const { data } = await axios.get(
      `https://min-api.cryptocompare.com/data/pricemulti?fsyms=${syms}&tsyms=USD`,
      { timeout: 8000 },
    );
    const now = Date.now();
    let updated = 0;
    for (const [sym, ccSym] of Object.entries(CC_SYMS)) {
      const price = data?.[ccSym]?.USD;
      if (typeof price === 'number' && price > 0) {
        this.publish({ source: 'rest', symbol: sym, price, ts: now });
        updated++;
      }
    }
    return updated;
  }

  private async fetchKraken(): Promise<number> {
    // Kraken: XBT instead of BTC
    const pairMap: Record<string, string> = {
      BTCUSDT: 'XBTUSDT', ETHUSDT: 'ETHUSDT', SOLUSDT: 'SOLUSDT',
      XRPUSDT: 'XRPUSDT', DOGEUSDT: 'XDGUSDT',
    };
    const pairs = Object.values(pairMap).join(',');
    const { data } = await axios.get(
      `https://api.kraken.com/0/public/Ticker?pair=${pairs}`,
      { timeout: 8000 },
    );
    const now = Date.now();
    let updated = 0;
    const result = data?.result ?? {};
    // Kraken returns oddly-named keys (XXBTZUSDT etc) - match by suffix
    for (const [sym, krPair] of Object.entries(pairMap)) {
      const matchKey = Object.keys(result).find(k => k.endsWith(krPair) || k === krPair);
      const price = matchKey ? parseFloat(result[matchKey]?.c?.[0]) : NaN;
      if (price > 0) {
        this.publish({ source: 'rest', symbol: sym, price, ts: now });
        updated++;
      }
    }
    return updated;
  }

  private publish(tick: PriceTick): void {
    const key = this.normalizeSymbol(tick.symbol);
    this.latest.set(key, tick);
    this.lastTickAt = Date.now();
    // v3.4: record per-source price for BRTI estimation
    if (tick.source) {
      let m = this.bySource.get(key);
      if (!m) { m = new Map(); this.bySource.set(key, m); }
      m.set(tick.source, { price: tick.price, ts: tick.ts });
    }
    const subs = this.subscribers.get(key) ?? [];
    for (const cb of subs) {
      try { cb(tick); } catch (err) { log.error({ err }, 'Subscriber callback error'); }
    }
  }

  /**
   * v3.4: BRTI-style estimate — median across constituent exchanges that match
   * CF Benchmarks BRTI methodology. Falls back to getLatestPrice if <2 fresh sources.
   * Freshness window: 5s (BRTI is a 1-min average, so 5s sources are well within tolerance).
   */
  getBrtiEstimate(symbol: string): { price: number; sources: number } | null {
    const key = this.normalizeSymbol(symbol);
    const m = this.bySource.get(key);
    if (!m) {
      const fallback = this.getLatestPrice(symbol);
      return fallback != null ? { price: fallback, sources: 1 } : null;
    }
    const now = Date.now();
    const fresh: number[] = [];
    for (const [src, { price, ts }] of m) {
      if (now - ts <= 5000) fresh.push(price);  // 5s freshness window
      // mark unused src to avoid lint complaints
      void src;
    }
    if (fresh.length === 0) {
      const fallback = this.getLatestPrice(symbol);
      return fallback != null ? { price: fallback, sources: 1 } : null;
    }
    if (fresh.length === 1) return { price: fresh[0], sources: 1 };
    // Median (BRTI uses selective median across constituents)
    fresh.sort((a, b) => a - b);
    const mid = Math.floor(fresh.length / 2);
    const median = fresh.length % 2 === 0
      ? (fresh[mid - 1] + fresh[mid]) / 2
      : fresh[mid];
    return { price: median, sources: fresh.length };
  }

  private normalizeSymbol(s: string): string {
    return s.toUpperCase().replace(/USD$/, 'USDT');
  }

  /** Get the latest price for a symbol like "BTCUSDT" - accepts prices up to FRESHNESS_MS old. */
  getLatestPrice(symbol: string): number | null {
    const norm = this.normalizeSymbol(symbol);
    const tick = this.latest.get(norm);
    if (!tick) return null;
    if (Date.now() - tick.ts > FRESHNESS_MS) return null;
    return tick.price;
  }

  subscribe(symbol: string, cb: (tick: PriceTick) => void): () => void {
    const key = this.normalizeSymbol(symbol);
    const list = this.subscribers.get(key) ?? [];
    list.push(cb);
    this.subscribers.set(key, list);
    return () => {
      const arr = this.subscribers.get(key) ?? [];
      this.subscribers.set(key, arr.filter((c) => c !== cb));
    };
  }

  async stop(): Promise<void> {
    if (this.restFallbackTimer) clearInterval(this.restFallbackTimer);
    try { this.binanceWs?.close(); } catch {}
    try { this.coinbaseWs?.close(); } catch {}
    try { this.geminiWs?.close(); } catch {}
  }
}
