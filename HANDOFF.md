# Kalshi Prediction Bot — Complete Handoff

> **Audience:** OpenClaw, future agents, or PandaXPanther returning after a break.
> **Generated:** June 1, 2026 11:00 PM MDT.
> **Bot state at this moment:** Online, panda-bot running v3.7 sizing on Chicago VPS, $942.46 cash, Monday cron recommends SHUTDOWN.

---

## ⚠️ Where the secrets are (read this first)

**Every credential the bot uses is stored at exactly ONE location:**

```
/opt/bot/.env  on the Chicago VPS  (chmod 600, root-owned)
```

That's it. Nowhere else. **This file is not — and must not be — committed to git, GitHub, this handoff, or any external location.**

The `.env` contains, in plain text:
- Kalshi RSA private key (PEM block) + access key ID
- Polymarket EOA private key (Magic Link / Steam OAuth derived) + L2 API credentials (key/secret/passphrase) + deposit wallet address + signature type
- Supabase service-role JWT
- Discord webhook URL + user ID to mention
- The Odds API key (Pinnacle source, $30/mo subscription)
- All strategy tuning knobs (Kelly, max trade size, hard stop, NO-only gate, etc.)

### How to access the secrets

You need SSH access to the Chicago VPS. The VPS host, root user, and root password are not in this document. They were given to you privately by PandaXPanther. If you don't have them:

1. Check Perplexity Computer's session memory under "Bot Infrastructure" — PandaXPanther pasted them into chat early in the project
2. Or ask PandaXPanther directly via Discord (his ID is in `DISCORD_NOTIFY_USER_ID` inside `.env` once you're on the box)

Once you're SSH'd in as root:

```bash
cat /opt/bot/.env
```

That gives you everything. Use `sudo` is not needed — you'll already be root.

### When/how to rotate secrets

| Secret | When to rotate | How |
|---|---|---|
| VPS root password | Right now (PandaXPanther leaked it in chat during setup) | `passwd root` on the VPS, update wherever it was pasted |
| Kalshi RSA key | If the .env file is ever exposed | Generate new on Kalshi.com → API → revoke old, paste new into .env |
| Polymarket API key | If the .env file is ever exposed | polymarket.com → settings → revoke + create new, derive L2 again |
| Polymarket EOA private key | NEVER share. If exposed, transfer funds out and create a fresh wallet | Custom flow — talk to PandaXPanther |
| Supabase service role JWT | If exposed | Supabase dashboard → API → rotate service_role key |
| Discord webhook | If exposed or returning 403s | Discord server settings → Integrations → Webhooks → regenerate URL |
| Odds API key | If exposed | the-odds-api.com → account → regenerate |

After ANY rotation: edit `.env` on the VPS, then `pm2 restart panda-bot --update-env`.

---

## 1. Account state (live snapshot at handoff time)

### Kalshi
- **Cash balance:** $942.46
- **Total equity:** $955.00 (cash + ~$12.54 in 1 open position)
- **Open positions:** 1 (will settle naturally within 24-48h)
- **Open orders:** 0
- **Account peak:** $1,021.16 (Thursday May 28, 7 AM MDT)
- **Bankroll hard-stop floor:** $900 (set by `BANKROLL_HARD_STOP` env var)
- **Headroom to hard-stop:** $42.46

### Polymarket — ABANDONED
- **Wallet:** ~$999.92 pUSD sitting at the deposit wallet
- **Status:** Cannot trade (US IP geoblock at API level). Read endpoints still work.
- **Pending action item:** PandaXPanther was supposed to withdraw the $1k via Polymarket UI. **Verify this happened.** If not, withdraw priority. The Magic Link key controls the wallet; withdrawal works even without API trading access.

### Lifetime project P&L (since project began ~5 weeks ago)
- Realized trade losses: ~$60–100 net
- VPS infrastructure spent: $720 prepaid (Chicago annual) + ~$60 (Dublin trial, now expired)
- Total project cost: roughly $80–100 cash burn + $780 in infrastructure (mostly sunk on Chicago)
- **Key offsetting value:** Chicago VPS now hosts OpenClaw alongside panda-bot, so the $720 isn't wasted infrastructure — it's effectively repurposed

---

## 2. Verdict from Monday June 1 cron (`e97cf9c8`)

**SHUT DOWN RECOMMENDED.** v3.7 aggressive sizing has performed poorly:

- 66 settled trades since v3.6 deploy (May 26 14:48 UTC)
- 28 wins / 38 losses = **WR 42.4%** (below 48% KEEP_RUNNING threshold, near the 42% BAD threshold)
- **Net P&L −$43.51** since v3.6 deploy
- Hard-stop at $900 has NOT triggered yet, but headroom is now only $42
- YES-bet gate intact (0 violations across all 66 settled trades) — the gate code works correctly
- Fill rate: 93%+ (the v3.5 maker-at-mid fix continues to work)

**The strategy doesn't have the edge needed to clear VPS costs at current sample size.**

---

## 3. Active strategy: sports_clv

### What it does (one paragraph)

`src/strategies/sportsCLV.ts` polls Kalshi sports markets (MLB primarily — NBA/NHL/NFL also tracked but no fires observed) every cycle. For each market, it fetches Pinnacle odds via The Odds API and computes a no-vig fair-value probability. If `|kalshi_mid − pinnacle_fair| ≥ MIN_DIV` AND the market is in the 30-min-to-8-hour pre-game window AND the price is in the $0.25–$0.80 band, the bot considers placing a bet. **In v3.6+, only NO bets are allowed** — the YES branch is gated off because v3.5 data showed YES bets at 20% WR vs NO bets at 50% WR (consistent with Becker 2026's documented "default YES bias" on Kalshi: retail systematically overprices YES contracts). The bot places a maker bid halfway between the current bid and Pinnacle fair value (v3.5 maker-at-mid fix). If the market moves before fill, it re-posts up to 3 times (maker chase, Discord-pinged each time). Kelly sizing is `kellySize × KELLY_MULT × bankroll`, capped at `MAX_TRADE_USD`.

### Current configuration (env-tunable, hot-reloadable)

| Variable | Current value | What it does |
|---|---|---|
| `SPORTS_NO_ONLY` | `true` | Disables all YES bets (rejects them before order placement) |
| `SPORTS_SKIP_TOSSUP` | `false` | If true, skips entries in $0.45–$0.55 band (currently off) |
| `SPORTS_KELLY_MULT` | `0.375` | Kelly fraction (4.7x v3.6 baseline) |
| `SPORTS_MAX_TRADE_USD` | `50` | Hard cap per trade |
| `BANKROLL_HARD_STOP` | `900` | Bot refuses new trades if cash < this |
| `SPORTS_CLV_MIN_DIV` | `0.03` | Minimum divergence to fire (3pp) |
| `SPORTS_FAST_POLL` | `true` | Poll Pinnacle every 60s instead of slower default |
| `PINNACLE_MAX_AGE_SECONDS` | `600` | Reject Pinnacle data older than 10 min |

To change any of these: edit `/opt/bot/.env`, then `pm2 restart panda-bot --update-env`. No code change or rebuild required.

### Reverting v3.7 → v3.6 sizing

If you want to undo the aggressive sizing in one command:

```bash
ssh root@<vps>
cd /opt/bot
sed -i 's/^SPORTS_KELLY_MULT=.*/SPORTS_KELLY_MULT=0.08/' .env
sed -i 's/^SPORTS_MAX_TRADE_USD=.*/SPORTS_MAX_TRADE_USD=20/' .env
pm2 restart panda-bot --update-env
```

### Other strategies in the codebase (most are inert)

| Strategy file | Status | Notes |
|---|---|---|
| `sportsCLV.ts` | ✅ ACTIVE | The only one firing trades currently |
| `kalshiHourlyCrypto.ts` | 🟡 Running but filtering everything out | Bates jump-diffusion; gates correctly reject low-edge BTC/ETH/SOL/XRP/DOGE setups; 0 fires in v3.6/v3.7 era |
| `weatherModel.ts` | 🟡 Running but inert | NWS station-obs correction; 0 fires |
| `liquidityIncentive.ts` (LIP) | 🔴 DISABLED | `LIP_ENABLED=false`. Lost $187 historically on political markets |
| `economicEvents.ts` | 🔴 Never wired into index.ts | Killed during initial v3 deploy |
| `crossPlatform.ts` | 🔴 Gated off | Polymarket arb — gated by `PLATFORM_MODE=kalshi_only` |
| `sumToOne.ts` / `kalshiSumToOne.ts` | 🔴 Polymarket-only | Same gate |
| `cryptoLatency.ts` / `sportsLatency.ts` | 🔴 Polymarket-only | Same gate |
| `crossStrikeArb.ts` | 🔴 Inactive | Coded but never enabled |
| `weatherSignal.ts` | 🔴 Inactive | Older weather variant superseded by `weatherModel.ts` |
| `nowcast.ts` | 🔴 Inactive | Economic events helper, orphaned |
| `cryptoEmpiricalModel.ts` | 🔴 Inactive | Crypto strategy helper, orphaned |
| `fundingRateFilter.ts` | 🔴 Inactive | Reserved for future perps integration |
| `adaptiveController.ts` | ⚙️ Helper | Shared Kelly fraction adapter used by sportsCLV |

To enable any disabled strategy, you'd need to (a) flip the relevant env var, (b) potentially modify `src/index.ts` to register/wire it, (c) confirm it doesn't conflict with the active sports gate. **Don't enable anything new without explicit reason — they were disabled because they lost money or aren't applicable.**

---

## 4. Infrastructure

### Chicago VPS (QuantVPS) — PRIMARY
- Specs: 4 cores / 8 GB / 75 GB NVMe / Ubuntu 22.04
- Cost: $59.99/mo, prepaid annually (≈$720/yr, sunk)
- Latency to Kalshi: ~2ms (matters less now that crypto/LIP are off; sports doesn't need this)
- **What runs on it (cohabitants):**
  - **panda-bot** — PM2 process, the Kalshi bot
  - **OpenClaw gateway** — port 18789
  - **Postgres** — port 5432 (OpenClaw dependency)
  - **Various other crons:** see `crontab -l` output in Section 11
- **Host/credentials:** See "Where the secrets are" at the top. Do NOT paste them in this doc.

### Dublin VPS — EXPIRED / REPURPOSED
- Was a 30-day trial. Cleanly wiped May 24 and given to OpenClaw migration testing.
- **Expires ~June 24, 2026. Do NOT renew.** Repurposed for OpenClaw which already moved to Chicago.

### Bot directory structure on Chicago

```
/opt/bot/
├── .env                          # SECRETS (chmod 600, never commit)
├── .env.bak.v180                 # backup of older env, also has secrets
├── .env.example                  # safe template, committed to repo
├── package.json
├── package-lock.json
├── tsconfig.json
├── Dockerfile
├── README.md
├── fly.toml                      # legacy from Fly.io migration, not used
├── src/                          # TypeScript source
│   ├── index.ts                  # entry point, wires strategies together
│   ├── connectors/
│   │   ├── kalshi.ts             # RSA-PSS signing, REST + WebSocket
│   │   ├── polymarket.ts         # legacy v1 client (not currently used)
│   │   ├── priceFeeds.ts         # BRTI-style multi-source spot (Coinbase WS + Gemini WS + Kraken REST + Bitstamp REST)
│   │   └── types.ts
│   ├── strategies/
│   │   ├── sportsCLV.ts          # ACTIVE — Kalshi sports vs Pinnacle
│   │   ├── sportsCLV.ts.v35_backup
│   │   ├── sportsCLV.ts.v36_backup
│   │   ├── kalshiHourlyCrypto.ts # running but inert
│   │   ├── weatherModel.ts       # running but inert
│   │   ├── ... (others, mostly disabled)
│   ├── risk/
│   │   ├── riskEngine.ts         # bankroll/exposure tracking
│   │   └── dripEngine.ts         # profit-reinvestment ("DRIP" Discord pings)
│   ├── utils/
│   │   ├── logger.ts             # pino structured logger
│   │   ├── discord.ts            # webhook poster
│   │   ├── config.ts             # env var schema
│   │   ├── watchdog.ts           # internal health watchdog (separate from cron)
│   │   └── httpResilience.ts     # axios retry interceptors
│   └── db/
│       └── supabase.ts           # heartbeat + trade log writer
├── dist/                         # compiled output of `npx tsc`
├── node_modules/
├── scripts/                      # one-off maintenance scripts (e.g. cancel-all-orders if it exists)
├── services/                     # auxiliary services
├── supabase/migrations/          # SQL migrations
├── migrations/                   # alt migrations location
├── docs/                         # mostly empty
├── audit_endpoint.ts             # one-off audit script
├── test_*.mts                    # paper-mode evaluation harnesses
└── bot.tar.gz                    # old tarball, can delete
```

### Build & run

```bash
cd /opt/bot
npx tsc                                # compiles src/ → dist/
pm2 restart panda-bot --update-env     # picks up new code AND new env values
pm2 logs panda-bot --lines 50 --nostream    # check recent activity
pm2 describe panda-bot                  # process details
```

---

## 5. SSH automation pattern (CRITICAL for any agent operating remotely)

If OpenClaw or any agent needs to run commands on the Chicago VPS from off-box, here's the pattern PandaXPanther's Perplexity Computer session used:

```python
#!/usr/bin/env python3
"""ssh_runner.py — reads command from stdin, runs over SSH with password baked in."""
import os, sys, pexpect
HOST = os.environ["BOT_HOST"]      # set via env, not hardcoded
USER = os.environ.get("BOT_USER", "root")
PASSWORD = os.environ["BOT_PASSWORD"]
cmd = sys.stdin.read().strip()
if not cmd:
    sys.exit("no command on stdin")
ssh = f"ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null {USER}@{HOST} {repr(cmd)}"
child = pexpect.spawn(ssh, encoding="utf-8", timeout=300)
i = child.expect(["password:", pexpect.EOF, pexpect.TIMEOUT])
if i == 0:
    child.sendline(PASSWORD)
    child.expect(pexpect.EOF)
print(child.before)
sys.exit(child.exitstatus or 0)
```

**Invocation pattern:**
```bash
export BOT_HOST=... BOT_PASSWORD=...
echo "cd /opt/bot && pm2 list" | python3 ssh_runner.py
```

**A common pitfall:** The script expects commands via stdin, NOT argv. The Monday cron failed once because it tried to pass the command as an argument. If you write your own version, you can change this — but document it.

A companion `scp_send.py` is structured identically but uses `scp` for file uploads.

**Since OpenClaw lives on Chicago directly, OpenClaw doesn't need any of this** — it can just operate on local files. This is only relevant for agents running from outside Chicago.

---

## 6. Version history (most recent first)

| Version | Date | Change | Result |
|---|---|---|---|
| **v3.7** | May 30 17:39 UTC | KELLY 0.08→0.375 (4.7x), MAX_TRADE $20→$50 (2.5x), added `BANKROLL_HARD_STOP=900` | **−$43 net over 6 days, recommended shutdown** |
| **v3.6** | May 26 14:48 UTC | Added `SPORTS_NO_ONLY=true` to gate off YES bets | Initially confirmed at n=17 (52.9% WR), regressed to 42.4% by n=66 |
| **v3.5** | May 24 17:13 UTC | Maker-at-mid fix: bid halfway between bid/ask when spread >3¢ on sports | Fixed 0% fill rate → 73% fill rate. Stayed at 35% WR overall but revealed NO-side edge |
| v3.4 | May 23 02:35 UTC | Bates jump-diffusion + BRTI multi-source crypto + stale-book gate | Crypto correctly filtering everything (0 fires since) |
| v3.3 | May 23 21:18 UTC | Crypto wide-spread maker fix | Live |
| v3.2 | May 23 17:45 UTC | Sports maker-chase with Discord ping | Live |
| v3.1 | May 23 17:35 UTC | 5-coin crypto expansion, weather NWS-obs, Deribit DVOL, sports 30min window | Live |
| v3 | May 23 16:35 UTC | Vol prior recalibration, Pinnacle home/away fix, weather suspended | Live |
| v176 | May 23 16:34 UTC | Initial research-backed deploy (maker-first, Kelly 0.075, $0.25–$0.80 band) | Live |
| v175 | May 23 16:25 UTC | Kalshi WebSocket migration (away from REST polling) | Live |

**Backup files preserved on VPS:**
- `src/strategies/sportsCLV.ts.v35_backup` — pre-v3.6 (before NO-only gate)
- `src/strategies/sportsCLV.ts.v36_backup` — pre-v3.7 (before Kelly bump)

---

## 7. Honest assessment of the bot's edge

### Numbers (66 settled trades since May 26)
- Win rate: **42.4%** — below the ~52% needed for a profitable Kalshi maker per academic baseline
- Net P&L: **−$43.51** over 6 days = roughly **−$215/mo extrapolated**
- Plus $60/mo VPS = roughly **−$275/mo total project cost**

### Why the v3.6 confirmation was misleading
Thursday May 28 cron at n=17 showed **52.9% WR** with **+$9.67** net P&L. This was front-loaded variance. By Saturday n=36, WR had regressed to 44.4%. By Monday n=66, WR was 42.4%. **The 95% confidence interval at n=17 was [29%, 76%]** — way too wide to act on. PandaXPanther asked to scale to v3.7 sizing on Saturday based on this incomplete sample (Option D, accepted 30-40% drawdown risk knowingly). That decision contributed materially to the current drawdown.

### Academic baseline ([Becker 2026, 72M Kalshi trades](https://jbecker.dev/research/prediction-market-microstructure))
Kalshi makers buying ≥$0.50 contracts earn approximately +2.6%/trade. At ~$3 avg trade size, that's $0.08/trade expected. The bot is running −$0.66/trade — **10x worse than the published academic mean**.

### Three possible interpretations
1. **No real edge.** Default-YES bias on Kalshi sports may be much smaller than Becker's full-platform finding (which was dominated by political markets). Likely.
2. **Real edge exists but is much smaller than v3.6's apparent +$0.57/trade.** Maybe +$0.05/trade. At current trade volume that's $30/mo — still below VPS cost. Plausible.
3. **Real edge exists but 66 trades is still on the wrong side of variance.** Need n=200+ to know definitively. Unlikely to be worth the further drawdown to find out.

### Conclusion
The strategy might profit at smaller sizing, might not. At v3.7 sizing the drawdown rate is too fast to wait for proof. At v3.6 sizing the recovery rate is too slow to clear VPS costs. **There isn't an obvious "tune harder" answer.** The cleanest move is shutdown + redirect capital to PandaXPanther's csfloat-sniper (proven returns).

---

## 8. Decision tree for OpenClaw

### Option A — Shut down (Monday cron's recommendation)

```bash
# On Chicago VPS:
pm2 stop panda-bot
pm2 save                      # persist the stopped state across reboots
# Wait 24-48h for the one open position to settle
# Cancel any orders that may post in the meantime via Kalshi UI
# Withdraw cash to bank via Kalshi UI → Withdraw → ACH
```

Then redirect $940-ish into PandaXPanther's csfloat-sniper CS2 trading operation (proven $120–220/mo on $1k per his historical data).

### Option B — Deescalate to v3.6 sizing, run another week

```bash
ssh root@<vps>
cd /opt/bot
sed -i 's/^SPORTS_KELLY_MULT=.*/SPORTS_KELLY_MULT=0.08/' .env
sed -i 's/^SPORTS_MAX_TRADE_USD=.*/SPORTS_MAX_TRADE_USD=20/' .env
pm2 restart panda-bot --update-env
```

Then schedule a check for Monday June 8 7:30 AM MDT (or whatever timing) to evaluate at n~80-100. If WR hasn't recovered to ≥48% by then, shut down.

### Option C — Wait for the hard-stop to fire on its own

The bot will self-pause new trades if cash drops below $900 (currently $942 — 4-5% headroom). At v3.7 sizing this could happen within 1-2 more losing sessions. Costs nothing in agent time to wait, but if it fires you'll lose another ~$40 first.

### What I would NOT recommend
- ❌ Adding capital. Strategy hasn't proven edge.
- ❌ Trying new strategies (crypto perps, Polymarket LP, NHL/NBA expansion) before resolving this.
- ❌ Increasing Kelly further. v3.7 was already aggressive given the data.
- ❌ Enabling SPORTS_SKIP_TOSSUP=true — only had n=7 support, way too small.

---

## 9. Diagnostic scripts (live at /tmp/ on Chicago)

These are NOT in the source repo. They live in `/tmp/` and may be cleared on reboot. PandaXPanther has the source in his Perplexity Computer chat history.

| Script | Purpose | How to run |
|---|---|---|
| `verdict36.mjs` | THE script. Computes WR, fill rate, P&L since v3.6 deploy (2026-05-26T14:48:21Z) | `cd /opt/bot && node /tmp/verdict36.mjs` |
| `diagnostic.mjs` | Per-pattern breakdown (side, price band, position size, time-to-game) | `cd /opt/bot && node /tmp/diagnostic.mjs` |
| `since_v35.mjs` | Top-level summary from v3.5 deploy timestamp | `cd /opt/bot && node /tmp/since_v35.mjs` |
| `health.sh` | PM2 status, log tail, error log, recent fires | `bash /tmp/health.sh` |
| `ssh_runner.py`, `scp_send.py` | Off-box SSH automation (not needed if OpenClaw is on Chicago) | See Section 5 |

If they're missing, OpenClaw can reconstruct them by reading the Kalshi connector source at `src/connectors/kalshi.ts` and the settlement payload schema. The key insight: P&L on each market = `(revenue/100) − yes_total_cost_dollars − no_total_cost_dollars − fee_cost`. Filter by `created_time >= v3.x deploy timestamp` to scope to a version's data.

---

## 10. Active scheduled crons (Perplexity Computer side)

These were created via Perplexity Computer's cron system. They're not in Chicago's crontab — they run from PandaXPanther's Computer session.

| ID | Name | Status |
|---|---|---|
| `31434f40` | Kalshi v3.5 Validation + Auto-Decision | Stale (annual recurrence) — ignore |
| `b408775a` | Kalshi v3.6 NO-only Validation | Stale (annual recurrence) — ignore |
| `08efe1d0` | Kalshi v3.6 Saturday re-check | Stale (annual recurrence) — ignore |
| `e97cf9c8` | Kalshi v3.6 Monday final check | **Last fired Mon Jun 1, recommended SHUTDOWN** |

If OpenClaw needs to schedule future validation checks, it has its own scheduler. PandaXPanther isn't actively scheduling new ones from his Computer side any more.

---

## 11. Chicago VPS system crontab (unrelated to bot)

Output of `crontab -l` on root (for context — none of these affect the bot directly):

```cron
CRON_TZ=America/Denver
0 14 * * *    /opt/news-brief/run.sh                                         # Daily news brief @ 8am MDT
30 3 * * *    /usr/local/bin/kodama-backup.sh >> /var/log/kodama-backup.log  # Kodama Postgres backup @ 3:30am MT
0 */4 * * *   /opt/escanor-state/snapshot.sh                                  # OpenClaw gateway healthcheck every 4h
0 */3 * * *   python3 /opt/usage-updater/update-status.py                     # Cost tracking + bio update every 3h
0 3 * * 0     /opt/refresh-codex-auth.sh                                      # Weekly auth refresh
11 * * * *    /opt/health-monitor.py                                          # Hourly health monitor
41 * * * *    /opt/anthropic-spend-watch.py                                   # Hourly Anthropic spend tracker
*/5 * * * *   /opt/codex-quota-state.py                                       # Codex quota tracker every 5min
```

These are OpenClaw / personal infrastructure. The Kalshi bot is managed by PM2, not cron.

---

## 12. Open positions, pending settlements, withdrawal plan

### State at handoff
- 1 open Kalshi position worth ~$12.54 (settles in 24-48h)
- 0 open orders
- $942.46 cash ready to withdraw

### Withdrawal sequence (if shutting down)
1. Stop new trading: `pm2 stop panda-bot`
2. Wait for the open position to settle (or close it manually via UI)
3. Verify cash balance via Kalshi UI matches `await k.getBalance()` from `src/connectors/kalshi.ts`
4. Kalshi UI → Withdraw → ACH to PandaXPanther's bank account (1-3 business days)
5. Separately: withdraw $1k from Polymarket UI if PandaXPanther hasn't already (US users can withdraw even though they can't trade)
6. Revoke Polymarket API key in settings after withdrawal completes
7. Optionally: revoke Kalshi API key as well

---

## 13. Data sources & APIs the bot uses

| Source | Purpose | Auth | Where in code |
|---|---|---|---|
| Kalshi REST API | Market data, order placement, settlements | RSA-PSS SHA256 signing | `src/connectors/kalshi.ts` |
| Kalshi WebSocket | Real-time order book + fill notifications | Same RSA-PSS | `src/connectors/kalshi.ts` |
| The Odds API (Pinnacle) | Sports no-vig fair-value odds | API key in `ODDS_API_KEY` | `src/strategies/sportsCLV.ts` |
| Coinbase WebSocket | Crypto spot price feed | Public | `src/connectors/priceFeeds.ts` |
| Gemini WebSocket | Crypto spot price feed | Public | `src/connectors/priceFeeds.ts` |
| Kraken REST | Crypto spot price feed (3s poll) | Public | `src/connectors/priceFeeds.ts` |
| Bitstamp REST | Crypto spot price feed (3s poll) | Public | `src/connectors/priceFeeds.ts` |
| Deribit DVOL | BTC/ETH implied volatility every 5min | Public | `src/strategies/kalshiHourlyCrypto.ts` |
| NWS station observations | Real-time weather temps for KNYC, KLAX, KORD, KMIA, KDEN, KSEA, KATL, KBOS, KIAH, KPHX, KDFW, KPHL, KSFO, KDCA, KAUS, KSAN, KPDX, KMSP, KDTW, KMCO, KTPA, KLAS | Public | `src/strategies/weatherModel.ts` |
| Supabase Postgres | Heartbeat + trade log writer | Service role JWT | `src/db/supabase.ts` |
| Discord webhook | Alerts (POSTED, FILL, KILL_SWITCH, DRIP, errors) | Webhook URL | `src/utils/discord.ts` |
| Polymarket CLOB | Polymarket V2 (currently abandoned) | Magic Link EOA + L2 API creds + POLY_1271 (sigType=3) | `src/connectors/polymarket.ts` (legacy v1; v2 connector was deleted when Dublin was wiped) |

### Kalshi signing recipe (because this took 3 attempts to get right)

```javascript
const ts = Date.now().toString();
const msg = ts + method.toUpperCase() + pathWithLeadingSlash;
const sig = crypto.sign('RSA-SHA256', Buffer.from(msg), {
  key: privateKeyPem,
  padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
  saltLength: 32,
});
return {
  'KALSHI-ACCESS-KEY': apiKeyId,
  'KALSHI-ACCESS-TIMESTAMP': ts,
  'KALSHI-ACCESS-SIGNATURE': sig.toString('base64'),
};
```

Hosts:
- Data: `https://api.elections.kalshi.com/trade-api/v2`
- Orders: `https://external-api.kalshi.com/trade-api/v2`
- WebSocket: `wss://api.elections.kalshi.com/trade-api/ws/v2`

---

## 14. Known issues / quirks / gotchas

### Discord webhook intermittently returns 403
Returned 403 Forbidden three times in the last week. Recovers on its own within hours. If it persists, regenerate the webhook URL in Discord server settings and update `DISCORD_WEBHOOK_URL` in `.env`.

### Bankroll glitch false alarm (May 26)
Internal kill switch fired at 5:22 PM MDT May 26 reading bankroll as $10.01 (from $1011.49). One-tick parsing bug — recovered on next reading. Did not impact trading. **The bug is unpatched.** If it triggers again, it will Discord-ping but won't actually halt trading because the safety logic self-clears on the next reading. Worth fixing properly someday in `src/utils/watchdog.ts`.

### Kalshi balance returns 0 if connector isn't `connect()`-ed first
`KalshiConnector` won't authenticate until `await k.connect()` is called. Some early debug scripts forgot this and returned $0 silently. All current diagnostic scripts handle it correctly.

### Magic Link Polymarket key derives to a wallet ≠ Polymarket's "API use" address
Polymarket Steam OAuth creates a proxy-wallet architecture where the Magic Link EOA is a separate contract from the deposit wallet. Use `signatureType=3` (POLY_1271) with the deposit wallet as `funderAddress`. The EOA private key signs orders on behalf of the deposit wallet via EIP-1271 contract signature validation.

### Polymarket geoblocks US IPs at API level
Order placement returns 403 from any US IP (Chicago is in the US). Read endpoints (balance, orders, markets) still work. PandaXPanther considered routing through Dublin VPS but ultimately abandoned Polymarket trading. **Do not retry without a non-US IP route AND legal acceptance of the gray-area approach** (Polymarket's TOS bars US persons, not just US IPs).

### Kalshi sometimes returns positions endpoint with stale data
Realized P&L on individual positions doesn't update until the next polling cycle. For ground-truth P&L use the **settlements endpoint** (`/portfolio/settlements`) and compute:
```
net_pnl = (revenue / 100) − yes_total_cost_dollars − no_total_cost_dollars − fee_cost
```

### PM2 has 32 lifetime restarts on this process
Most are intentional (v3.x deploys + the May 26 internal kill-switch trigger). A few may be unexplained crashes. If PM2 starts auto-restarting more than once a day, check `/root/.pm2/logs/panda-bot-error.log`.

### Polymarket v2 connector code was deleted
When Dublin VPS was wiped on May 24, the `polymarketV2.ts` connector that used `@polymarket/clob-client-v2` was deleted along with it. The current `src/connectors/polymarket.ts` is the legacy v1 client which is **non-functional** against Polymarket V2's pUSD architecture. If anyone wants to revive Polymarket integration, they'd need to rebuild this. The original code is documented in PandaXPanther's Perplexity Computer chat history from May 24.

---

## 15. Communication conventions PandaXPanther uses

- **Brutal honesty over encouragement.** He once said "stop fucking lying pick a side" — that's the tone he prefers.
- **Pointed questions, short answers.** No fluff. No emojis unless he uses them first.
- **He'll say "do whatever you need to" or "do what you think is best" — but he wants the math and tradeoffs explained anyway.** Don't take the open-ended phrasing as a license to act without showing reasoning.
- **Don't promise specific profits without data to back them.**
- **Mention him in Discord with `<@572590897150296083>`** for all alerts.
- **He's a high school student** running multiple ventures (ATT Agency, csfloat-sniper, this bot, Thryve esports). Time is his real constraint.

---

## 16. Reports & research in PandaXPanther's workspace

All in `/home/user/workspace/` on his Perplexity Computer session (not in this repo):

| File | What it is |
|---|---|
| `HANDOFF.md` (this doc, public version) | Sanitized handoff |
| `HANDOFF_PRIVATE.md` | Original handoff version with secrets — never committed |
| `kalshi_v35_validation_report.md` | Tuesday May 26 — first verdict (BAD overall, found NO-bias pattern) |
| `kalshi_v36_validation_report.md` | Thursday May 28 — second verdict (CONFIRMED at n=17) |
| `kalshi_v36_saturday_validation_report.md` | Saturday May 30 — third verdict (WEAK at n=36) |
| `kalshi_v37_monday_report.md` | Monday June 1 — fourth verdict (SHUT DOWN at n=66) |
| `no_only_hypothesis_brief.md` | Academic stress-test of NO-only hypothesis citing Becker 2026, GWU "Makers or Takers" 2026, etc. |
| `polymarket-lp-rewards-strategy.pplx.md` | Deep research on Polymarket LP rewards (mostly negative findings) |
| `strategy_v3_optimization.pplx.md` | Original Tier 1 research that drove v3 |
| `kalshi_crypto_model_v2.pplx.md` | Crypto-focused deep research (v3 baseline) |
| `path_to_profit.md` | Original profitability analysis |
| `latency_optimization.pplx.md` | VPS migration research |
| `exact_settings.md` | v174 specific settings |
| `VPS_CREDENTIALS.md` | Has the actual VPS credentials — keep local, never commit |

If OpenClaw needs any of these, PandaXPanther can paste them or share-file them.

---

## 17. The honest one-paragraph summary

PandaXPanther spent ~5 weeks building this bot. It taught him a lot about market microstructure, RSA signing, multi-platform crypto wallet architectures, adverse selection, Kelly criterion, the "default YES bias" on prediction markets, and the difference between confirming variance and confirming edge. Lifetime financial loss is roughly **$60–100** (depending on settlement of the last open position). Lifetime infrastructure cost is roughly **$80–100 in actual cash burn** + **$720 in prepaid Chicago VPS** that's now hosting OpenClaw (so not wasted). The Kalshi sports strategy *might* have a real edge that's smaller than v3.6's apparent +$0.57/trade — but 66 trades isn't enough to prove it, and at v3.7 sizing the drawdown rate is too fast to wait. The right call is probably to shut down trading on this bot, redirect the $940-ish into csfloat-sniper (which has proven returns), and use the Chicago VPS as OpenClaw infrastructure plus whatever else PandaXPanther builds next. If a future operator wants to revive prediction-market trading, the codebase is solid, the lessons are documented in this handoff, and the validation framework (cron-based statistically-thresholded auto-evaluation) is a real artifact worth reusing. But the immediate next action is probably "stop trading, withdraw cash."

---

*Document version: 2.0 · Generated June 1, 2026 11:00 PM MDT · Repo: `pandaxpanther-prediction-bot/HANDOFF.md`*
