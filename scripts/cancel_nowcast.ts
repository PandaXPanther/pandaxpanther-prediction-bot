/**
 * Emergency: cancel all open nowcast orders (long-dated CPI contracts that would lock capital till Nov 2026).
 */
import { KalshiConnector } from '../src/connectors/kalshi.js';
import axios from 'axios';

const NOWCAST_ORDER_IDS = [
  'dd40dbb5-0d2d-4a95-a6bc-899d1fff55b4',
  '311b0a1e-f170-42ce-9b8c-4b3a72f4bdee',
  'd6d0b2dd-211b-44b5-b3cc-377b02c53fd4',
  '860d6976-b6a5-44f1-bbc3-9a8684f426de',
  '6139ba80-46ad-4f1e-bbd1-6e74f0a54be4',
  '0c644794-1fb6-42c7-b8a0-427c928143ca',
];

const SUPABASE_URL = 'https://aikeswwopdatvqqbbhmu.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

async function main() {
  const k = new KalshiConnector();
  await k.connect();
  console.log('Connected to Kalshi. Cancelling orders...');

  let canceled = 0, failed = 0;
  for (const id of NOWCAST_ORDER_IDS) {
    try {
      const ok = await k.cancelOrder(id);
      if (ok) {
        canceled++;
        console.log(`✓ Canceled ${id}`);
        // Update Supabase
        await axios.patch(
          `${SUPABASE_URL}/rest/v1/orders?external_order_id=eq.${id}`,
          { status: 'canceled', ts_canceled: new Date().toISOString() },
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' } }
        );
      } else {
        failed++;
        console.log(`✗ Failed to cancel ${id}`);
      }
    } catch (err: any) {
      failed++;
      console.log(`✗ Error cancelling ${id}: ${err.message}`);
    }
  }
  console.log(`\nDone. Canceled: ${canceled}, Failed: ${failed}`);
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
