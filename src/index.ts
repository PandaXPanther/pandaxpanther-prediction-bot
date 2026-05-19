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

import { getConfig } from './utils/config.js';
import { logger } from './utils/logger.js';
import { sendDiscord } from './utils/discord.js';
import { PolymarketConnector } from './connectors/polymarket.js';
import { KalshiConnector } from './connectors/kalshi.js';
import { PriceFeedAggregator } from './connectors/priceFeeds.js';
import { getRiskEngine } from './risk/riskEngine.js';
import { SumToOneStrategy } from './strategies/sumToOne.js';
import { CrossPlatformStrategy } from './strategies/crossPlatform.js';
import { CryptoLatencyStrategy } from './strategies/cryptoLatency.js';
import { WeatherStrategy } from './strategies/weatherSignal.js';

async function main() {
  const config = getConfig();
  logger.info({ mode: config.TRADING_MODE, bankroll: 5000 }, '🐼 PandaXPanther Prediction Bot starting');
  await sendDiscord(
    `🐼 Bot online (${config.TRADING_MODE.toUpperCase()})`,
    'All strategies booting...',
    'info'
  );

  const polymarket = new PolymarketConnector();
  const kalshi = new KalshiConnector();
  const priceFeeds = new PriceFeedAggregator();

  await Promise.all([
    polymarket.connect().catch((err) => logger.error({ err }, 'Polymarket connect failed')),
    kalshi.connect().catch((err) => logger.error({ err }, 'Kalshi connect failed')),
    priceFeeds.start().catch((err) => logger.error({ err }, 'Price feeds failed')),
  ]);

  // Sync bankroll from live balances (paper mode returns simulated $5K each)
  const [pmBal, kBal] = await Promise.all([polymarket.getBalance(), kalshi.getBalance()]);
  const totalBankroll = pmBal + kBal;
  getRiskEngine().setBankroll(totalBankroll);
  logger.info({ pmBal, kBal, totalBankroll }, 'Bankroll synced');

  const strategies: { name: string; start: () => Promise<void> }[] = [
    { name: 'sum_to_one', start: () => new SumToOneStrategy(polymarket).start() },
    { name: 'cross_platform', start: () => new CrossPlatformStrategy(polymarket, kalshi).start() },
    { name: 'crypto_latency', start: () => new CryptoLatencyStrategy(polymarket, priceFeeds).start() },
    { name: 'weather', start: () => new WeatherStrategy(kalshi).start() },
  ];

  for (const s of strategies) {
    s.start()
      .then(() => logger.info({ strategy: s.name }, '✓ Strategy running'))
      .catch((err) => logger.error({ err, strategy: s.name }, '✗ Strategy failed to start'));
  }

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
    await Promise.allSettled([polymarket.disconnect(), kalshi.disconnect(), priceFeeds.stop()]);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, 'Fatal error in main');
  process.exit(1);
});
