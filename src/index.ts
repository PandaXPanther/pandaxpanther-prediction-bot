/**
 * MAIN ORCHESTRATOR
 *
 * Boots all connectors, instantiates all strategies, and runs them concurrently.
 *
 * Usage:
 *   npm run dev           # all strategies, paper mode
 *   npm run all           # alias
 *   npm run strategy:sum-to-one  # just one strategy
 *
 * Environment must include TRADING_MODE=paper for safe initial testing.
 */

import { installHttpResilience } from './utils/httpResilience.js';
import { getConfig, isKalshiOnly } from './utils/config.js';
import { logger } from './utils/logger.js';
import { sendDiscord } from './utils/discord.js';
import { PolymarketConnector } from './connectors/polymarket.js';
import { KalshiConnector } from './connectors/kalshi.js';
import { PriceFeedAggregator } from './connectors/priceFeeds.js';
import { getRiskEngine } from './risk/riskEngine.js';
import { DripEngine } from './risk/dripEngine.js';
import { SumToOneStrategy } from './strategies/sumToOne.js';
import { CrossPlatformStrategy } from './strategies/crossPlatform.js';
import { CryptoLatencyStrategy } from './strategies/cryptoLatency.js';
import { WeatherStrategy } from './strategies/weatherSignal.js';
import { KalshiSumToOneStrategy } from './strategies/kalshiSumToOne.js';
import { NowcastStrategy } from './strategies/nowcast.js';
import { SportsLatencyStrategy } from './strategies/sportsLatency.js';
import { KalshiHourlyCryptoStrategy } from './strategies/kalshiHourlyCrypto.js';
import { EconomicEventsStrategy } from './strategies/economicEvents.js';
import { LiquidityIncentiveStrategy } from './strategies/liquidityIncentive.js';
import { SportsCLVStrategy } from './strategies/sportsCLV.js';
import { startWatchdog, setNetworkHealthSources, setAuditProbe } from './utils/watchdog.js';

async function main() {
  // Install global axios retry interceptor BEFORE any HTTP traffic.
  installHttpResilience();
  const config = getConfig();
  const mode = isKalshiOnly() ? 'KALSHI-ONLY' : 'BOTH';
  logger.info({ mode: config.TRADING_MODE, platformMode: mode, bankroll: 5000 }, '🐼 PandaXPanther Prediction Bot starting');
  // Note: We DON'T Discord-ping on every boot. Fly may restart the container
  // and we don't want to spam the channel. Real activity (signals/fills) is
  // the only thing that should ping.

  const kalshi = new KalshiConnector();
  await kalshi.connect().catch((err) => logger.error({ err }, 'Kalshi connect failed'));

  // Price feeds ALWAYS run (needed for hourly crypto strategy on Kalshi)
  const priceFeeds = new PriceFeedAggregator();
  await priceFeeds.start().catch((err) => logger.error({ err }, 'Price feeds failed'));

  // Polymarket only needed for 'both' mode strategies
  let polymarket: PolymarketConnector | null = null;
  if (!isKalshiOnly()) {
    polymarket = new PolymarketConnector();
    await polymarket.connect().catch((err) => logger.error({ err }, 'Polymarket connect failed'));
  }

  // Start DRIP engine - fetches real Kalshi balance every 5 min and
  // compounds profits automatically into the risk engine bankroll.
  const drip = new DripEngine(kalshi);
  await drip.start();

  const strategies: { name: string; start: () => Promise<void> }[] = isKalshiOnly()
    ? [
        // Kalshi-only stack — v3 deploy:
        // - Crypto: high-volume, calibrated against Kraken GARCH
        // - Sports CLV: validated edge per Networked study + Pinnacle freshness gate
        // - Weather: SUSPENDED (v3 back-test 0/11 WR; NWS forecast is dumber than Kalshi market)
        // - Nowcast: DISABLED (paper-only, no real fires)
        // - Sum-to-one: DISABLED (books over-round)
        // To re-enable weather: set WEATHER_ENABLED=true after switching to NWS
        // real-time station data and passing 20 paper trades.
        ...(process.env.WEATHER_ENABLED === 'true'
          ? [{ name: 'weather', start: () => new WeatherStrategy(kalshi).start() }]
          : []),
        // 2026-05-23: economic_events DISABLED. Lost $33 on CPI markets with
        // bad signal source (Cleveland Fed nowcast misaligned with Kalshi's
        // monthly resolution). Will re-enable after the signal calibration is
        // verified against historical CPI prints.
        { name: 'kalshi_hourly_crypto', start: () => new KalshiHourlyCryptoStrategy(kalshi, priceFeeds).start() },
        // 2026-05-23: LIP REMOVED. The strategy was placing buys on political
        // markets it should not have touched, costing $150+ overnight. Removed
        // entirely from startup list — the $1.14 daily reward was not worth the
        // capital loss. Kept the file in src/ for reference but never started.
        { name: 'sports_clv', start: () => new SportsCLVStrategy(kalshi).start() },
      ]
    : [
        // Full Polymarket + Kalshi stack
        { name: 'sum_to_one', start: () => new SumToOneStrategy(polymarket!).start() },
        { name: 'cross_platform', start: () => new CrossPlatformStrategy(polymarket!, kalshi).start() },
        { name: 'crypto_latency', start: () => new CryptoLatencyStrategy(polymarket!, priceFeeds).start() },
        { name: 'weather', start: () => new WeatherStrategy(kalshi).start() },
        // economic_events disabled — see comment in primary branch above.
        { name: 'kalshi_hourly_crypto', start: () => new KalshiHourlyCryptoStrategy(kalshi, priceFeeds).start() },
        // LIP removed — see comment above.
        { name: 'sports_clv', start: () => new SportsCLVStrategy(kalshi).start() },
      ];

  for (const s of strategies) {
    s.start()
      .then(() => logger.info({ strategy: s.name }, '✓ Strategy running'))
      .catch((err) => logger.error({ err, strategy: s.name }, '✗ Strategy failed to start'));
  }

  // Start the watchdog AFTER strategies have begun. The watchdog monitors the
  // strategy heartbeat. If it stops firing (network hang, event loop wedge),
  // process.exit(1) triggers Fly's restart policy.
  // Hook price-feed staleness into the watchdog BEFORE starting it.
  setNetworkHealthSources({ getPriceLastTickAt: () => priceFeeds.getLastTickAt() });
  // One-shot stale-order sweep, gated by STALE_ORDER_SWEEP=true env var.
  // Cancels any open order whose client_order_id starts with the legacy 'bot-' prefix
  // (which was used before strategies adopted strategy-specific prefixes).
  // After running once successfully, the operator should unset the env to prevent
  // re-running it across redeploys.
  if (process.env.STALE_ORDER_SWEEP === 'true') {
    try {
      const openOrders = await kalshi.getOpenOrders() as any[];
      const targets = openOrders.filter(o => String(o?.client_order_id ?? '').startsWith('bot-'));
      logger.info({ totalOpen: openOrders.length, sweepTargets: targets.length }, '🧹 One-shot stale-order sweep starting');
      let cancelled = 0;
      for (const o of targets) {
        try {
          await kalshi.cancelOrder(o.order_id);
          cancelled++;
          const { markOrderCancelledByExternalId } = await import('./db/supabase.js');
          await markOrderCancelledByExternalId(o.order_id, 'stale-sweep').catch(() => null);
        } catch (err: any) {
          logger.debug({ orderId: o.order_id, err: err.message }, 'sweep: cancel failed (probably filled/expired)');
        }
      }
      logger.info({ cancelled, attempted: targets.length }, '🧹 Stale-order sweep complete');
      // Only ping Discord when we actually did something — silent no-op otherwise
      // so we don't spam every redeploy.
      if (cancelled > 0) {
        void sendDiscord('🧹 Stale-order sweep', `Cancelled ${cancelled} of ${targets.length} legacy bot- orders. Total open before: ${openOrders.length}.`, 'info');
      }
    } catch (err: any) {
      logger.error({ err: err.message }, 'Stale-order sweep failed');
    }
  }

  // Hook the live Kalshi order summary into /audit/lip for external inspection.
  const buildAuditSnapshot = async () => {
    const orders = (await kalshi.getOpenOrders()) as any[];
    const positions = await kalshi.tryGetPositions();
    let lipCount = 0, lipNotional = 0, otherCount = 0, otherNotional = 0;
    const byPrefix: Record<string, number> = {};
    const lipDetails: any[] = [];
    for (const o of orders) {
      const coid = String(o.client_order_id || '');
      // Kalshi uses string-dollar fields (yes_price_dollars) and *_fp counts; not the int-cents fields used elsewhere in the codebase.
      const yesPx = parseFloat(o.yes_price_dollars ?? '') || (o.yes_price ?? 0) / 100;
      const noPx  = parseFloat(o.no_price_dollars ?? '')  || (o.no_price ?? 0)  / 100;
      const px = (o.side === 'yes') ? yesPx : noPx;
      const sz = parseFloat(o.remaining_count_fp ?? '') || Number(o.remaining_count ?? o.count ?? 0);
      const notional = px * sz;
      const prefix = coid.split('-')[0] || '(none)';
      byPrefix[prefix] = (byPrefix[prefix] || 0) + 1;
      if (coid.startsWith('lip-')) {
        lipCount++; lipNotional += notional;
        if (lipDetails.length < 5) {
          // Capture FULL raw order so we can see what fields Kalshi is returning
          lipDetails.push({ ...o });
        }
      } else {
        otherCount++; otherNotional += notional;
      }
    }
    // Include raw position dumps so we can debug the flatten logic. Dump ALL positions (not filtered).
    const nonzeroPositions = positions.slice(0, 8);
    return {
      ts: new Date().toISOString(),
      kalshi_open_orders: orders.length,
      lip: { count: lipCount, notionalUsd: +lipNotional.toFixed(2) },
      non_lip: { count: otherCount, notionalUsd: +otherNotional.toFixed(2) },
      byPrefix,
      lipDetails,
      positions: nonzeroPositions,
    };
  };
  setAuditProbe(buildAuditSnapshot);
  // Also publish the snapshot to Supabase every 2 min so we can audit from outside
  // without needing SSH or the HTTP endpoint (sandbox DNS can be flaky).
  setInterval(async () => {
    try {
      const snap = await buildAuditSnapshot();
      const { recordSignal } = await import('./db/supabase.js');
      await recordSignal({ strategy: 'kalshi_audit', acted: false, reason: 'live_orders_snapshot', payload: snap as any });
    } catch (err: any) {
      logger.debug({ err: err.message }, 'audit snapshot publish failed');
    }
  }, 120_000);
  startWatchdog();

  // Periodic stats heartbeat
  setInterval(() => {
    const stats = getRiskEngine().getStats();
    logger.info(stats, '📊 Risk stats heartbeat');
  }, 5 * 60 * 1000);

  // Daily summary
  setInterval(async () => {
    const stats = getRiskEngine().getStats();
    await sendDiscord(
      '📊 Daily Risk Report',
      'PandaXPanther Bot — 24h snapshot',
      'info',
      [
        { name: 'Daily PnL', value: `$${stats.dailyPnl.toFixed(2)}`, inline: true },
        { name: 'Bankroll', value: `$${stats.bankroll.toFixed(2)}`, inline: true },
        { name: 'Killed', value: stats.killed ? 'YES' : 'no', inline: true },
      ]
    );
  }, 24 * 60 * 60 * 1000);

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    const tasks: Promise<any>[] = [kalshi.disconnect(), priceFeeds.stop()];
    if (polymarket) tasks.push(polymarket.disconnect());
    await Promise.allSettled(tasks);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Global handlers so transient errors don't kill the bot.
// Critical for production: a strategy throwing on one tick shouldn't crash
// the whole orchestrator. Logged + swallowed.
process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled promise rejection');
});
process.on('uncaughtException', (err) => {
  logger.error({ err: err.message, stack: err.stack }, 'Uncaught exception (continuing)');
});

main().catch((err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'Fatal error in main - keeping process alive');
  // Do NOT exit. Even if main() throws, the timers + WebSocket might still
  // work and we'd rather have a degraded bot than a restart loop.
});

// Keep process alive forever - belt and suspenders. Some Node versions exit
// when all 'awaited' Promises settle. setInterval should be enough, but this
// is a guarantee.
setInterval(() => {}, 1 << 30);
