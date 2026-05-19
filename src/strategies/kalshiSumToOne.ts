/**
 * STRATEGY: Sum-to-One Arbitrage (Kalshi)
 *
 * THESIS:
 *   Same math as the Polymarket sum-to-one strategy, but applied to Kalshi
 *   binary contracts. Kalshi quotes prices in cents (1-99). When the best
 *   ask for YES + best ask for NO sums to less than 100 cents, we can
 *   guarantee profit by buying both sides.
 *
 *   Kalshi has lower competition than Polymarket for this strategy because
 *   most Kalshi users are retail bettors who don't run automated scanners.
 *
 * IMPORTANT:
 *   On Kalshi, you place orders against the YES side only - the platform
 *   automatically routes a "buy NO at price X" as "sell YES at price (100-X)".
 *   So buying YES at $0.45 + buying NO at $0.52 (which is "selling YES at $0.48")
 *   nets you $1.00 - $0.45 - $0.52 = $0.03 per contract if both fill.
 *
 *   Kalshi WS subscriptions require authentication. In paper mode (no creds),
 *   this strategy polls REST every 30s instead - lower frequency but still
 *   useful for evaluation.
 */

import { KalshiConnector } from '../connectors/kalshi.js';
import { getRiskEngine } from '../risk/riskEngine.js';
import { createStrategyLogger } from '../utils/logger.js';
import { sendDiscord } from '../utils/discord.js';
import { isPermissive, getConfig, shouldPingPaperFills, isAggressive } from '../utils/config.js';
import { upsertMarket, recordSignal, recordOrder, recordHeartbeat } from '../db/supabase.js';
import axios from 'axios';

const log = createStrategyLogger('kalshi_sum_to_one');

const TRIGGER_SUM_PROD = 0.97;           // 3% gross edge minimum
const MIN_EDGE_PROD = 0.015;             // 1.5% net minimum
const TRIGGER_SUM_PERMISSIVE = 0.995;    // 0.5% gross edge
const MIN_EDGE_PERMISSIVE = 0.002;       // 0.2% net edge

// Aggressive = same as permissive (drop thresholds way down)
const getTriggerSum = () => (isPermissive() || isAggressive() ? TRIGGER_SUM_PERMISSIVE : TRIGGER_SUM_PROD);
const getMinEdge = () => (isPermissive() || isAggressive() ? MIN_EDGE_PERMISSIVE : MIN_EDGE_PROD);

interface KalshiMarketSnapshot {
  ticker: string;
  title: string;
  yesAsk: number | null;  // dollars
  noAsk: number | null;
  yesAskQty: number;
  noAskQty: number;
  marketDbId?: string;
}

export class KalshiSumToOneStrategy {
  private snapshots = new Map<string, KalshiMarketSnapshot>();
  private opportunitiesSeen = 0;
  private bestSumSeen = 2;
  private bestSumTicker = '';
  // Rolling tightest tracker for hourly Discord ping
  private intervalBestSum = 2;
  private intervalBestTicker = '';
  private intervalBestYesAsk = 0;
  private intervalBestNoAsk = 0;
  private intervalScans = 0;
  private inFlight = new Set<string>();

  constructor(private kalshi: KalshiConnector) {}

  async start(): Promise<void> {
    log.info('Kalshi sum-to-one strategy starting (REST polling mode)');
    // Initial discovery
    await this.scanMarkets();
    // Re-scan every 30 seconds in paper mode (will be WS in live)
    setInterval(() => this.scanMarkets(), 30_000);

    // Heartbeat every 60s
    setInterval(() => {
      const payload = {
        snapshots: this.snapshots.size,
        opportunitiesAboveThreshold: this.opportunitiesSeen,
        bestSumSeen: Number(this.bestSumSeen.toFixed(4)),
        bestTicker: this.bestSumTicker,
        intervalScans: this.intervalScans,
      };
      void recordHeartbeat('kalshi_sum_to_one', getConfig().TRADING_MODE, payload);
    }, 60_000);

    // Hourly Discord activity ping
    setInterval(() => this.sendActivityPing(), 15 * 60 * 1000)  // 15 min for permissive paper visibility;
  }

  /**
   * Scan top Kalshi markets and pull authenticated order book data.
   *
   * The public /markets endpoint returns null prices on the
   * api.elections.kalshi.com host. We need to use the authenticated
   * connector to get real book data. Strategy: discover high-volume
   * tickers via the public list, then for each one query the
   * connector's signed orderbook endpoint.
   */
  private async scanMarkets(): Promise<void> {
    try {
      const config = getConfig();
      // 1) Discover open markets across multiple high-activity series
      const seriesToScan = [
        'KXHIGHNY', 'KXHIGHLAX', 'KXHIGHCHI', 'KXHIGHMIA', 'KXHIGHDEN',  // weather
        'KXNBAGAME', 'KXMLBGAME', 'KXNFLGAME', 'KXNHLGAME',              // sports
        'KXCPI', 'KXCPIYOY', 'KXJOBS', 'KXFEDDECISION', 'KXGDP',         // macro
        'KXBTC', 'KXETH',                                                 // crypto
      ];
      this.intervalScans++;
      let parsed = 0;
      let discovered = 0;

      for (const series of seriesToScan) {
        try {
          const r = await axios.get(`${config.KALSHI_HOST}/markets`, {
            params: { series_ticker: series, status: 'open', limit: 100 },
            timeout: 10000,
            headers: { 'User-Agent': 'panda-bot' },
          });
          const markets = (r.data?.markets ?? []) as any[];

          for (const m of markets.slice(0, 30)) {
            discovered++;
            // For each ticker, fetch authenticated orderbook for real prices
            const book = await this.kalshi.getMarketOrderbook(m.ticker);
            if (!book) continue;

            const yesAskCents = book.yesAsk;
            const noAskCents = book.noAsk;
            if (yesAskCents == null || noAskCents == null) continue;
            if (yesAskCents <= 0 || noAskCents <= 0) continue;

            const yesAsk = yesAskCents / 100;
            const noAsk = noAskCents / 100;
            parsed++;

            let snap = this.snapshots.get(m.ticker);
            if (!snap) {
              const marketDbId = await upsertMarket({
                platform: 'kalshi',
                external_id: m.ticker,
                question: m.title ?? m.subtitle ?? m.ticker,
                category: m.event_ticker?.split('-')[0]?.toLowerCase(),
                outcome: 'YES',
                closes_at: m.close_time ? new Date(m.close_time) : undefined,
                metadata: { event_ticker: m.event_ticker, series_ticker: series },
              }) ?? undefined;
              snap = {
                ticker: m.ticker,
                title: m.title ?? m.subtitle ?? m.ticker,
                yesAsk, noAsk,
                yesAskQty: book.yesAskQty ?? 0,
                noAskQty: book.noAskQty ?? 0,
                marketDbId,
              };
              this.snapshots.set(m.ticker, snap);
            } else {
              snap.yesAsk = yesAsk;
              snap.noAsk = noAsk;
              snap.yesAskQty = book.yesAskQty ?? 0;
              snap.noAskQty = book.noAskQty ?? 0;
            }

            await this.evaluate(snap);
          }
        } catch (err: any) {
          if (err.response?.status !== 404) {
            log.debug({ series, status: err.response?.status }, 'Series scan error');
          }
        }
      }
      log.info({ discovered, parsed, snapshots: this.snapshots.size }, 'Kalshi authenticated market scan');
    } catch (err: any) {
      log.error({ err: err.message }, 'Kalshi market scan error');
    }
  }

  private async evaluate(snap: KalshiMarketSnapshot): Promise<void> {
    if (this.inFlight.has(snap.ticker)) return;
    if (snap.yesAsk == null || snap.noAsk == null) return;

    const sum = snap.yesAsk + snap.noAsk;

    // Track absolute best
    if (sum < this.bestSumSeen) {
      this.bestSumSeen = sum;
      this.bestSumTicker = snap.ticker;
    }
    // Track interval best
    if (sum < this.intervalBestSum) {
      this.intervalBestSum = sum;
      this.intervalBestTicker = snap.ticker;
      this.intervalBestYesAsk = snap.yesAsk;
      this.intervalBestNoAsk = snap.noAsk;
    }

    if (sum >= getTriggerSum()) return;

    this.opportunitiesSeen++;

    const grossEdge = 1.0 - sum;
    const netEdge = grossEdge; // Kalshi has very small fees, ignore for now
    const recommended = Math.min(snap.yesAskQty, snap.noAskQty) * Math.max(snap.yesAsk, snap.noAsk);

    const signalId = await recordSignal({
      strategy: 'kalshi_sum_to_one',
      market_id: snap.marketDbId,
      edge_bps: Math.round(grossEdge * 10000),
      market_prob: snap.yesAsk,
      recommended_size_usd: recommended,
      side: 'ARB_BUY_BOTH',
      reason: netEdge < getMinEdge() ? 'below_min_edge' : 'actionable',
      payload: {
        yesAsk: snap.yesAsk,
        noAsk: snap.noAsk,
        sum,
        grossEdge,
        title: snap.title,
      },
    });

    if (netEdge < getMinEdge()) return;

    // Sized & actionable - check risk & fire
    const risk = getRiskEngine();
    const check = risk.canTrade('kalshi_sum_to_one', snap.ticker, recommended);
    if (!check.allowed) return;

    const sizeContracts = Math.floor(check.sizeUsd / Math.max(snap.yesAsk, snap.noAsk));
    if (sizeContracts < 1) return;

    this.inFlight.add(snap.ticker);
    log.info({ ticker: snap.ticker, sum, netEdge, sizeContracts }, 'Kalshi sum-to-one opportunity');

    if (shouldPingPaperFills()) {
      await sendDiscord(
        '🔔 Kalshi sum-to-one opportunity',
        snap.title,
        'success',
        [
          { name: 'YES ask', value: snap.yesAsk.toFixed(4), inline: true },
          { name: 'NO ask', value: snap.noAsk.toFixed(4), inline: true },
          { name: 'Sum', value: sum.toFixed(4), inline: true },
          { name: 'Net edge', value: `${(netEdge * 100).toFixed(2)}%`, inline: true },
          { name: 'Size', value: sizeContracts.toString(), inline: true },
          { name: 'Mode', value: 'PAPER', inline: true },
        ]
      );
    }

    try {
      const [yesRes, noRes] = await Promise.all([
        this.kalshi.placeOrder({
          externalId: snap.ticker, outcome: 'YES', side: 'BUY', orderType: 'IOC',
          price: snap.yesAsk, size: sizeContracts,
        }),
        this.kalshi.placeOrder({
          externalId: snap.ticker, outcome: 'NO', side: 'BUY', orderType: 'IOC',
          price: snap.noAsk, size: sizeContracts,
        }),
      ]);

      const mode = getConfig().TRADING_MODE;
      void recordOrder({
        signal_id: signalId ?? undefined,
        market_id: snap.marketDbId,
        strategy: 'kalshi_sum_to_one',
        mode, side: 'BUY', order_type: 'IOC',
        price: snap.yesAsk, size: sizeContracts, outcome: 'YES',
        external_order_id: yesRes.externalOrderId,
        status: (yesRes.filled ?? 0) > 0 ? 'filled' : 'rejected',
        filled_size: yesRes.filled ?? 0,
      });
      void recordOrder({
        signal_id: signalId ?? undefined,
        market_id: snap.marketDbId,
        strategy: 'kalshi_sum_to_one',
        mode, side: 'BUY', order_type: 'IOC',
        price: snap.noAsk, size: sizeContracts, outcome: 'NO',
        external_order_id: noRes.externalOrderId,
        status: (noRes.filled ?? 0) > 0 ? 'filled' : 'rejected',
        filled_size: noRes.filled ?? 0,
      });

      if ((yesRes.filled ?? 0) > 0 && (noRes.filled ?? 0) > 0) {
        const profit = sizeContracts * netEdge;
        risk.recordDeployment('kalshi_sum_to_one', snap.ticker, recommended);
        await risk.recordPnl('kalshi_sum_to_one', profit, snap.ticker);
        await sendDiscord(
          '💰 Kalshi sum-to-one filled',
          snap.title,
          'success',
          [
            { name: 'YES ask', value: snap.yesAsk.toFixed(4), inline: true },
            { name: 'NO ask', value: snap.noAsk.toFixed(4), inline: true },
            { name: 'Size', value: sizeContracts.toString(), inline: true },
            { name: 'Profit', value: `$${profit.toFixed(2)}`, inline: true },
          ]
        );
      }
    } catch (err) {
      log.error({ err }, 'Kalshi order error');
    } finally {
      setTimeout(() => this.inFlight.delete(snap.ticker), 2000);
    }
  }

  private async sendActivityPing(): Promise<void> {
    const overspread = this.intervalBestSum - 1.0;
    const label = overspread <= 0
      ? `🟢 ARB! ${(-overspread * 100).toFixed(2)}% under fair`
      : `⚪ Tightest seen: ${(overspread * 100).toFixed(2)}% over fair`;

    await sendDiscord(
      '📊 Kalshi sum-to-one hourly',
      `Monitoring **${this.snapshots.size} Kalshi markets** via REST scanning.\n\n${label}`,
      overspread <= 0 ? 'success' : 'info',
      [
        { name: 'Tightest market', value: this.intervalBestTicker.slice(0, 80) || 'none yet', inline: false },
        { name: 'YES ask', value: this.intervalBestYesAsk ? this.intervalBestYesAsk.toFixed(4) : '-', inline: true },
        { name: 'NO ask', value: this.intervalBestNoAsk ? this.intervalBestNoAsk.toFixed(4) : '-', inline: true },
        { name: 'Sum', value: this.intervalBestSum.toFixed(4), inline: true },
        { name: 'Scans / hr', value: this.intervalScans.toLocaleString(), inline: true },
        { name: 'Mode', value: getConfig().TRADING_MODE.toUpperCase(), inline: true },
      ]
    );

    this.intervalBestSum = 2;
    this.intervalBestTicker = '';
    this.intervalBestYesAsk = 0;
    this.intervalBestNoAsk = 0;
    this.intervalScans = 0;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const k = new KalshiConnector();
  await k.connect();
  const strat = new KalshiSumToOneStrategy(k);
  await strat.start();
  log.info('Kalshi sum-to-one strategy running.');
}
