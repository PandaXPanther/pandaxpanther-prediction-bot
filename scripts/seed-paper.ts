/**
 * Seed script: validates connectivity end-to-end in paper mode.
 * Run with: `npx tsx scripts/seed-paper.ts`
 */

import { PolymarketConnector } from '../src/connectors/polymarket.js';
import { KalshiConnector } from '../src/connectors/kalshi.js';
import { PriceFeedAggregator } from '../src/connectors/priceFeeds.js';
import { logger } from '../src/utils/logger.js';

async function run() {
  logger.info('=== Seed: connectivity check ===');

  // Polymarket
  const pm = new PolymarketConnector();
  await pm.connect();
  const pmMarkets = await pm.listActiveMarkets();
  logger.info({ count: pmMarkets.length }, 'Polymarket markets fetched');
  logger.info({ sample: pmMarkets.slice(0, 3).map((m) => m.question) }, 'Polymarket sample');

  // Kalshi
  const k = new KalshiConnector();
  await k.connect();
  const kMarkets = await k.listActiveMarkets();
  logger.info({ count: kMarkets.length }, 'Kalshi markets fetched');
  logger.info({ sample: kMarkets.slice(0, 3).map((m) => m.question) }, 'Kalshi sample');

  // Price feeds
  const pf = new PriceFeedAggregator();
  await pf.start();
  setTimeout(() => {
    const btc = pf.getLatestPrice('BTCUSDT');
    const eth = pf.getLatestPrice('ETHUSDT');
    const sol = pf.getLatestPrice('SOLUSDT');
    logger.info({ btc, eth, sol }, 'Live crypto prices');
    process.exit(0);
  }, 5000);
}

run().catch((err) => {
  logger.fatal({ err }, 'Seed failed');
  process.exit(1);
});
