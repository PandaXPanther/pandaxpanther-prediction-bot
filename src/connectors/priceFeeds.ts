import WebSocket from 'ws';
import { getConfig } from '../utils/config.js';
import { createStrategyLogger } from '../utils/logger.js';

const log = createStrategyLogger('priceFeeds');

export type PriceTick = {
  source: 'binance' | 'coinbase';
  symbol: string;
  price: number;
  ts: number;
};

/**
 * Real-time crypto price feed aggregator.
 *
 * Maintains WebSocket connections to Binance and Coinbase, exposing
 * a low-latency last-trade price for each symbol.
 *
 * Reference prices are used by the crypto latency arb strategy to detect
 * stale Polymarket pricing on BTC/ETH/SOL 15-minute window contracts.
 */
export class PriceFeedAggregator {
  private latest = new Map<string, PriceTick>();
  private subscribers = new Map<string, ((tick: PriceTick) => void)[]>();
  private binanceWs: WebSocket | null = null;
  private coinbaseWs: WebSocket | null = null;

  // Symbols to track (in Binance format)
  private symbols = ['btcusdt', 'ethusdt', 'solusdt'];

  async start(): Promise<void> {
    await Promise.all([this.connectBinance(), this.connectCoinbase()]);
  }

  private async connectBinance(): Promise<void> {
    const config = getConfig();
    const streams = this.symbols.map((s) => `${s}@trade`).join('/');
    const url = `${config.BINANCE_WS_URL}/stream?streams=${streams}`;
    this.binanceWs = new WebSocket(url);
    this.binanceWs.on('open', () => log.info('Binance WS connected'));
    this.binanceWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        const trade = msg.data;
        if (trade?.s && trade?.p) {
          this.publish({
            source: 'binance',
            symbol: trade.s,
            price: parseFloat(trade.p),
            ts: trade.T ?? Date.now(),
          });
        }
      } catch (err) {
        log.debug({ err }, 'Binance parse error');
      }
    });
    this.binanceWs.on('error', (err) => log.error({ err }, 'Binance WS error'));
    this.binanceWs.on('close', () => {
      log.warn('Binance WS closed - reconnecting in 5s');
      setTimeout(() => this.connectBinance(), 5000);
    });
  }

  private async connectCoinbase(): Promise<void> {
    const config = getConfig();
    this.coinbaseWs = new WebSocket(config.COINBASE_WS_URL);
    this.coinbaseWs.on('open', () => {
      log.info('Coinbase WS connected');
      this.coinbaseWs!.send(
        JSON.stringify({
          type: 'subscribe',
          product_ids: ['BTC-USD', 'ETH-USD', 'SOL-USD'],
          channels: ['ticker'],
        })
      );
    });
    this.coinbaseWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ticker' && msg.product_id && msg.price) {
          this.publish({
            source: 'coinbase',
            symbol: msg.product_id.replace('-', ''),
            price: parseFloat(msg.price),
            ts: new Date(msg.time).getTime(),
          });
        }
      } catch (err) {
        log.debug({ err }, 'Coinbase parse error');
      }
    });
    this.coinbaseWs.on('error', (err) => log.error({ err }, 'Coinbase WS error'));
    this.coinbaseWs.on('close', () => {
      log.warn('Coinbase WS closed - reconnecting in 5s');
      setTimeout(() => this.connectCoinbase(), 5000);
    });
  }

  private publish(tick: PriceTick): void {
    const key = this.normalizeSymbol(tick.symbol);
    this.latest.set(key, tick);
    const subs = this.subscribers.get(key) ?? [];
    for (const cb of subs) {
      try {
        cb(tick);
      } catch (err) {
        log.error({ err }, 'Subscriber callback error');
      }
    }
  }

  private normalizeSymbol(s: string): string {
    return s.toUpperCase().replace(/USD$/, 'USDT');
  }

  /** Get the latest price across sources for a symbol like "BTCUSDT". */
  getLatestPrice(symbol: string): number | null {
    const norm = this.normalizeSymbol(symbol);
    const tick = this.latest.get(norm);
    if (!tick) return null;
    // Only consider price fresh if within last 5 seconds
    if (Date.now() - tick.ts > 5000) return null;
    return tick.price;
  }

  /** Subscribe to ticks for a specific symbol. */
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
    this.binanceWs?.close();
    this.coinbaseWs?.close();
  }
}
