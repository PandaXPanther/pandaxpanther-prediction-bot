# Kalshi Prediction Bot — Complete Handoff

> **⚠️ Secrets are NOT in this file.** They live in two places only:
> 1. `/opt/bot/.env` on the Chicago VPS (chmod 600)
> 2. The private operator handoff doc at `~/workspace/HANDOFF_PRIVATE.md` (kept local, never committed)
>
> If you're OpenClaw or a successor agent reading this from GitHub: you still need to obtain the credentials separately from PandaXPanther.

**Author note for OpenClaw / future operator:** This document is the single source of truth for the state of the bot as of **June 1, 2026 11:00 PM MDT**. PandaXPanther is handing off operational responsibility.

---

## 1. Current state snapshot

### Account (live from Kalshi API)
- **Cash balance:** $942.46
- **Total equity:** $955.00 (cash + ~$12.54 in 1 open position)
- **Bot status:** Online, 2 days uptime, 32 lifetime restarts, 419 MB RAM
- **Last code change:** v3.7 deployed 2026-05-30 17:39 UTC (Sat May 30, 11:39 AM MDT)

### Project P&L since v3.5 deploy (May 24, 2026)
- v3.5 era: Started at ~$1,003, peaked at $1,021.16 (Thursday May 28), now $942.46
- **Total drawdown from peak: −$78.70**
- **Net since project start: −$60 (roughly)**
- VPS sunk cost: $720/yr Chicago (prepaid). Dublin VPS was repurposed for OpenClaw.

### Verdict from Monday June 1 cron
**SHUT DOWN RECOMMENDED.** v3.7 aggressive sizing has performed poorly:
- 66 settled trades since v3.6 deploy (May 26)
- 28W / 38L = **WR 42.4%** (below the 48% KEEP_RUNNING threshold)
- **Net P&L −$43.51** since v3.6 deploy
- Hard-stop at $900 has NOT triggered yet (cash $973.62 at the time of Monday cron, $942.46 now — closer)
- YES-bet gate intact (0 violations)

### Active strategy: sports_clv v3.7
- **MIN_DIV:** 3pp
- **MAX_DIV:** 15pp
- **KELLY_MULT:** 0.375 (4.7x v3.6's 0.08)
- **MAX_TRADE_USD:** $50 (2.5x v3.6's $20)
- **SPORTS_NO_ONLY:** true (only places NO bets — never YES)
- **BANKROLL_HARD_STOP:** $900 (bot auto-pauses new trades if cash < $900)

### Other strategies (running but rarely fire)
- `kalshi_hourly_crypto` — Bates jump-diffusion on BTC/ETH/SOL/XRP/DOGE binaries. Filtering gates correctly reject most opportunities; fired 0 orders in v3.6/v3.7 era.
- `weather` — NWS station obs correction. Fired 0 orders in v3.6/v3.7 era.
- `liquidityIncentive` (LIP) — DISABLED. Lost $187 historically.
- `economic_events` — never wired into config. Killed.
- `crossPlatform`, `sumToOne`, `cryptoLatency` — Polymarket-only, gated off by `PLATFORM_MODE=kalshi_only`.

---

## 2. Infrastructure

### Chicago VPS (QuantVPS) — PRIMARY
- **Specs:** 4 cores / 8 GB / 75 GB NVMe / Ubuntu 22.04
- **Cost:** $59.99/mo, prepaid annually (≈$720/yr, sunk)
- **What runs here:**
  - **panda-bot** (Kalshi prediction bot) — `pm2` process
  - **OpenClaw** — gateway on port 18789 (alongside, no conflict)
  - **Postgres** — port 5432 (OpenClaw dependency)
- **Ping to Kalshi:** ~2ms
- **Access:** see `HANDOFF_PRIVATE.md` for IP/credentials

### Dublin VPS — EXPIRED / REPURPOSED
- 30-day trial. Wiped clean May 24, given to OpenClaw migration test. **Should expire ~June 24. Do not renew.**

### Bot directory
- `/opt/bot/` on Chicago
- Source: `/opt/bot/src/`
- Compiled output: `/opt/bot/dist/`
- Env file: `/opt/bot/.env` (chmod 600)
- Build: `npx tsc` from `/opt/bot/`
- Run: `pm2 start dist/index.js --name panda-bot` (already running)

---

## 3. Secrets management

All secrets are stored in `/opt/bot/.env` on the Chicago VPS with mode `600`. **Nothing sensitive is committed to this repo.**

Required env vars (see `.env.example` for the empty template):

| Variable | Purpose |
|---|---|
| `KALSHI_API_KEY_ID` | Kalshi access key UUID |
| `KALSHI_PRIVATE_KEY` | RSA private key for Kalshi RSA-PSS signing |
| `KALSHI_HOST`, `KALSHI_ORDER_HOST`, `KALSHI_WSS` | Kalshi endpoints |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | State logging |
| `DISCORD_WEBHOOK_URL`, `DISCORD_NOTIFY_USER_ID` | Alerts |
| `ODDS_API_KEY` | Pinnacle odds via The Odds API |
| `POLYMARKET_PRIVATE_KEY`, `POLYMARKET_FUNDER_ADDRESS`, `POLYMARKET_SIGNATURE_TYPE` | Polymarket (currently abandoned but keys still present) |
| `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, `POLYMARKET_API_PASSPHRASE` | Polymarket L2 |
| `TRADING_MODE` | `live` or `paper` |
| `SPORTS_NO_ONLY`, `SPORTS_SKIP_TOSSUP`, `SPORTS_KELLY_MULT`, `SPORTS_MAX_TRADE_USD`, `BANKROLL_HARD_STOP` | v3.6/v3.7 sizing knobs |
| `PLATFORM_MODE` | `kalshi_only` currently |
| `WEATHER_ENABLED`, `BINANCE_DISABLED`, `LIP_ENABLED` | Strategy toggles |

**To rotate any credential:** edit `/opt/bot/.env` on the VPS, then `pm2 restart panda-bot --update-env`. Do not commit the result.

---

## 4. SSH automation pattern

The bot is accessed via a pexpect SSH script. **It reads commands from stdin, not argv** — this caught the v3.6 Monday cron off guard.

```python
#!/usr/bin/env python3
"""Reads command from stdin, runs over SSH with password baked in."""
import os, sys, pexpect
HOST = os.environ["BOT_HOST"]
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

Set `BOT_HOST`, `BOT_USER`, `BOT_PASSWORD` env vars before running. Invoke as:

```bash
echo "cd /opt/bot && pm2 list" | python3 ssh_runner.py
```

A companion `scp_send.py` is structured identically for file uploads.

---

## 5. Version history (most recent first)

| Version | Date | What changed | Result |
|---|---|---|---|
| **v3.7** | May 30 17:39 UTC | KELLY 0.08→0.375, MAX_TRADE $20→$50, added BANKROLL_HARD_STOP=$900 | **Losing — recommended shutdown June 1** |
| **v3.6** | May 26 14:48 UTC | Added `SPORTS_NO_ONLY=true` env flag — disables all YES bets | Initially confirmed (52.9% WR n=17), then regressed (44.4% WR n=36, then 42.4% n=66) |
| **v3.5** | May 24 17:13 UTC | Maker-at-mid fix — bid halfway between bid/ask when spread >3¢ on sports | Fixed 0% fill rate → 73% fill rate, but only 35% WR |
| v3.4 | May 23 ~02:35 UTC | Bates jump-diffusion + BRTI multi-source + stale-book gate | Crypto fires 0 orders since |
| v3.3 | May 23 ~21:18 UTC | Crypto wide-spread maker fix | Live |
| v3.2 | May 23 ~17:45 UTC | Sports maker-chase with Discord ping | Live |
| v3.1 | May 23 ~17:35 UTC | 5-coin crypto, weather NWS-obs, Deribit DVOL, sports 30min window | Live |
| v3 | May 23 ~16:35 UTC | Vol prior recalibration, Pinnacle home/away fix, weather suspended | Live |

**Backups on Chicago VPS:**
- `src/strategies/sportsCLV.ts.v35_backup` — pre-v3.6 (before NO-only gate)
- `src/strategies/sportsCLV.ts.v36_backup` — pre-v3.7 (before Kelly bump)

To revert to v3.6 sizing, set in `/opt/bot/.env`:
```
SPORTS_KELLY_MULT=0.08
SPORTS_MAX_TRADE_USD=20
```
…then `pm2 restart panda-bot --update-env`. No code change needed.

---

## 6. The strategy in one paragraph

`sportsCLV.ts` polls Kalshi sports markets (MLB primarily — NBA/NHL/NFL also tracked but no fires observed) every cycle. For each market, it fetches Pinnacle odds via The Odds API and computes a no-vig fair-value probability. If `|kalshi_mid − pinnacle_fair| ≥ 3pp` AND the market is in the 30-min-to-8-hour pre-game window AND the price is in the $0.25-$0.80 band, the bot considers placing a bet. **In v3.6+, only NO bets are allowed** — the YES branch is gated off because v3.5 data showed YES bets at 20% WR vs NO bets at 50% WR (Becker's "default YES bias" — Kalshi retail systematically overprices YES contracts). The bot places a maker bid halfway between the current bid and Pinnacle fair value (v3.5 fix). If the market moves before fill, it re-posts up to 3 times (maker chase). Kelly sizing is `kellySize × KELLY_MULT × bankroll`, capped at `MAX_TRADE_USD`.

---

## 7. Honest assessment of the bot's edge

### What the data says (66 settled trades since May 26)
- WR: 42.4% — **below the academic baseline** of ~52% needed for a profitable Kalshi maker
- Net P&L: −$43.51 over 6 days = **~−$215/mo extrapolated**
- Plus $60/mo VPS cost = **~−$275/mo realistic project cost**

### Why the v3.6 confirmation was misleading
The Thursday May 28 cron showed 52.9% WR at n=17 with +$9.67 net P&L. **This was front-loaded variance.** By Saturday n=36, WR had regressed to 44.4%. By Monday n=66, WR was 42.4%. The 95% confidence interval at n=17 was [29%, 76%] — way too wide to act on. **The bot was scaled up to v3.7 sizing before the n=17 confirmation could be validated at n=30+.** That decision contributed materially to the current drawdown.

### Academic baseline (Becker 2026, 72M Kalshi trades)
Kalshi makers buying ≥$0.50 contracts earn approximately +2.6%/trade. At ~$3 avg trade size, that's $0.08/trade expected. We're running −$0.66/trade.

### The honest range of possibilities
1. **No real edge.** Default-YES bias on Kalshi sports may be smaller than Becker's full-platform finding. Likely.
2. **Real edge exists but is much smaller than v3.6's apparent +$0.57/trade.** Maybe +$0.05/trade. At current trade volume that's $30/mo — still below VPS cost. Plausible.
3. **Real edge exists but variance hasn't normalized yet.** Need n=200+ to know. Unlikely to be worth waiting given current drawdown rate.

**Conclusion:** the burden of proof is now on the bot to recover. At v3.7 sizing, the next 5-loss streak could trigger the hard-stop. At deescalated v3.6 sizing, the recovery rate is slow enough that VPS costs dominate.

---

## 8. Decision tree for OpenClaw

### Option A — Shut down (recommended by Monday cron)
```bash
# On Chicago VPS:
pm2 stop panda-bot
pm2 save
# Cancel all open orders via Kalshi UI
# Withdraw funds to bank account via Kalshi UI
```
Then redirect $940-ish into csfloat-sniper CS2 trading operation (proven $120-220/mo on $1k).

### Option B — Deescalate to v3.6 sizing, run another week
```bash
# On Chicago VPS:
ssh root@<chicago_ip>
sed -i 's/^SPORTS_KELLY_MULT=.*/SPORTS_KELLY_MULT=0.08/' /opt/bot/.env
sed -i 's/^SPORTS_MAX_TRADE_USD=.*/SPORTS_MAX_TRADE_USD=20/' /opt/bot/.env
pm2 restart panda-bot --update-env
```
Then schedule a check for Monday June 8 7:30 AM MDT to evaluate at n~80-100. If WR hasn't recovered to ≥48% by then, shut down.

### Option C — Wait for the hard-stop to fire
The bot will self-pause if cash drops below $900 (currently $942 — 4-5% headroom). At v3.7 sizing this could happen in 1-2 more losing sessions. Costs nothing to wait, but if it fires you'll lose another ~$40 first.

### What I would NOT recommend
- ❌ Adding capital. The strategy hasn't proven edge.
- ❌ Trying new strategies (crypto perps, Polymarket LP) before resolving this one.
- ❌ Increasing Kelly further. v3.7 was already aggressive given the data.
- ❌ Adding new sports (NBA/NFL/NHL) — they're already tracked but haven't fired; that's the gate doing its job, not a missing opportunity.

---

## 9. Active scheduled crons

All Perplexity Computer crons currently scheduled by PandaXPanther:

| ID | Name | Status |
|---|---|---|
| `31434f40` | Kalshi v3.5 Validation + Auto-Decision | Stale (annual recurrence) — ignore |
| `b408775a` | Kalshi v3.6 NO-only Validation | Stale (annual recurrence) — ignore |
| `08efe1d0` | Kalshi v3.6 Saturday re-check | Stale (annual recurrence) — ignore |
| `e97cf9c8` | Kalshi v3.6 Monday final check | **Last fired Mon Jun 1, recommended SHUTDOWN** |

Native crontab on Chicago is unrelated to bot operations (news-brief, OpenClaw healthcheck, etc.).

**If OpenClaw wants to schedule new bot diagnostic crons:** can write its own systemd timer or crontab entry directly on Chicago.

---

## 10. Diagnostic scripts (live on Chicago at /tmp/)

| Script | Purpose | How to run |
|---|---|---|
| `verdict36.mjs` | **THE script.** Computes WR, fill rate, P&L since v3.6 deploy (2026-05-26T14:48:21Z) | `cd /opt/bot && node /tmp/verdict36.mjs` |
| `diagnostic.mjs` | Per-pattern breakdown (side, price band, position size, time-to-game) | `cd /opt/bot && node /tmp/diagnostic.mjs` |
| `since_v35.mjs` | Top-level summary from v3.5 deploy timestamp | `cd /opt/bot && node /tmp/since_v35.mjs` |
| `health.sh` | PM2 status, log tail, error log, recent fires | `bash /tmp/health.sh` |

These are not in version control; they live in `/tmp/` and may be cleared on reboot. PandaXPanther has copies if needed.

---

## 11. Open positions, pending settlements, withdrawal plan

### As of June 1 11:00 PM MDT
- **1 open Kalshi position** worth ~$12.54 — will settle naturally over the next 24-48h
- **0 open orders** — clean
- **Cash ready to withdraw:** $942.46

### Withdrawal sequence (if shutting down)
1. Wait for the open position to settle (24-48h)
2. Cancel any new orders the bot places in the meantime (or pm2 stop first)
3. Log into Kalshi UI → Withdraw → ACH to bank
4. Polymarket: separately withdraw $1k from the deposit wallet via Polymarket UI if not already done
5. Revoke Polymarket API key in settings after withdrawal completes

---

## 12. Known issues / quirks / gotchas

### Discord webhook intermittently 403s
Three times this past week the webhook returned 403 Forbidden. Each time it recovered on its own within a few hours. If it persists, regenerate the webhook URL in the Discord server settings.

### Bankroll glitch false alarm (May 26)
The internal kill switch fired at 5:22 PM MDT May 26 reading bankroll as $10.01 (from $1011.49). One-tick parsing bug — recovered on next reading. Did not impact trading. The bug is unpatched. If it triggers again it will Discord-ping but won't actually halt trading because the safety logic self-clears.

### Kalshi balance returns 0 if connector isn't `connect()`-ed first
The `KalshiConnector` class won't authenticate until `await k.connect()` is called. Some early debug attempts forgot this and returned $0 silently. All current scripts handle it correctly.

### Magic Link Polymarket key derives to a wallet ≠ Polymarket's "API use" address
Polymarket Steam OAuth creates a proxy-wallet architecture where the Magic Link EOA is a separate contract from the deposit wallet. Use **signatureType=3 (POLY_1271)** with the deposit wallet as the funder address.

### Polymarket geoblocks US IPs at API level
Order placement returns 403 from any US IP. Read endpoints (balance, orders, markets) still work. PandaXPanther accepted this risk by considering routing through Dublin VPS but ultimately abandoned Polymarket trading. **Do not retry without a non-US IP route.**

---

## 13. Communication conventions PandaXPanther uses

- **Brutal honesty preferred** over encouragement.
- **Pointed questions, short answers.** No fluff. No emojis unless he uses them first.
- **He'll usually say "do whatever you need to" or "do what you think is best" — but he wants the math and tradeoffs explained anyway.**
- Don't promise specific profits without data to back them.
- Mention him in Discord notifications using his user ID (in env as `DISCORD_NOTIFY_USER_ID`).

---

## 14. The honest one-paragraph summary

PandaXPanther spent ~5 weeks building this bot. It taught him a lot about market microstructure, RSA signing, multi-platform crypto wallet architectures, adverse selection, and Kelly criterion. Lifetime financial loss is ~$60-100 (depending on settlement of the last open position). Lifetime infrastructure cost is ~$120 actual cash + $720 prepaid Chicago VPS that's now hosting OpenClaw. The strategy might have a real but smaller-than-needed edge, or it might have no edge at all — 66 trades isn't enough to know for sure. The right call is probably to shut down trading on this bot, redirect the $940-ish into csfloat-sniper (which has proven returns), and use the Chicago VPS as OpenClaw infrastructure. If a future operator wants to revive prediction-market trading, the codebase is solid and the lessons here are documented. But the immediate next action is probably "stop trading, withdraw cash."

---

*Document version: 1.0 · Generated June 1, 2026 11:00 PM MDT*
