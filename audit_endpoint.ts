// Add this temporarily to dump fills + settlements via a Fly machine exec
import { KalshiConnector } from './src/connectors/kalshi.js';
const k = new KalshiConnector();
async function main() {
  const httpAny = (k as any).http;
  const sign = (k as any).sign.bind(k);

  for (const ep of ['/portfolio/fills', '/portfolio/settlements', '/portfolio/positions', '/portfolio/orders']) {
    try {
      const ts = Date.now();
      const headers = sign('GET', `/trade-api/v2${ep}`, ts);
      const { data } = await httpAny.get(ep, { headers, params: { limit: 50 } });
      console.log(`\n=== ${ep} ===`);
      console.log(JSON.stringify(data, null, 2).slice(0, 3000));
    } catch (e: any) {
      console.log(`${ep}: ${e.response?.status} ${JSON.stringify(e.response?.data)?.slice(0,200)}`);
    }
  }
}
main().catch(e=>{console.error(e.message);process.exit(1);});
