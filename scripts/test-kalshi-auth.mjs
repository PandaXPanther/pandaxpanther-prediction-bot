// Quick test: hit Kalshi authenticated endpoints with the saved credentials.
// Usage: node scripts/test-kalshi-auth.mjs
import crypto from 'crypto';
import axios from 'axios';
import fs from 'fs';

const KEY_ID = process.env.KALSHI_API_KEY_ID;
const PEM = process.env.KALSHI_PRIVATE_KEY || fs.readFileSync(process.env.KALSHI_PRIVATE_KEY_PATH || './secrets/kalshi_private_key.pem', 'utf8');
const HOST = process.env.KALSHI_HOST || 'https://api.elections.kalshi.com/trade-api/v2';

function sign(method, path, ts) {
  const message = `${ts}${method}${path}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(message);
  signer.end();
  return signer.sign({ key: PEM, padding: crypto.constants.RSA_PKCS1_PSS_PADDING }, 'base64');
}

async function probe(method, path) {
  const ts = Date.now();
  const sig = sign(method, `/trade-api/v2${path}`, ts);
  try {
    const r = await axios({
      method,
      url: `${HOST}${path}`,
      headers: {
        'KALSHI-ACCESS-KEY': KEY_ID,
        'KALSHI-ACCESS-SIGNATURE': sig,
        'KALSHI-ACCESS-TIMESTAMP': ts.toString(),
        'User-Agent': 'panda-bot-test',
      },
      timeout: 10000,
    });
    console.log(`[${r.status}] ${method} ${path}`);
    return r.data;
  } catch (e) {
    console.log(`[${e.response?.status ?? 'ERR'}] ${method} ${path}: ${JSON.stringify(e.response?.data ?? e.message).slice(0, 200)}`);
    return null;
  }
}

const bal = await probe('GET', '/portfolio/balance');
if (bal) console.log('  Balance:', JSON.stringify(bal));
const positions = await probe('GET', '/portfolio/positions?limit=5');
if (positions) console.log('  Positions:', JSON.stringify(positions).slice(0, 200));
// Try a high-volume ticker - NBA game tonight
const ob = await probe('GET', '/markets/KXNBAGAME-26MAY19CLENYK-NYK/orderbook');
if (ob) console.log('  Orderbook:', JSON.stringify(ob).slice(0, 300));
const mk = await probe('GET', '/markets/KXNBAGAME-26MAY19CLENYK-NYK');
if (mk) console.log('  Market:', JSON.stringify(mk).slice(0, 300));
