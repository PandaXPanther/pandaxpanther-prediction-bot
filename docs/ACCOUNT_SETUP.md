# Account Setup Checklist

Detailed walkthrough for going from paper → live. Have your parent on standby for the KYC steps.

---

## 1. Supabase (free, do first)

- [ ] Create project at https://supabase.com/dashboard
- [ ] SQL Editor → run `supabase/migrations/0001_initial_schema.sql`
- [ ] Settings → API → copy `Project URL` and `service_role secret`
- [ ] Paste into `.env`

## 2. Discord (free, optional but strongly recommended)

- [ ] Create or pick a Discord server
- [ ] Server Settings → Integrations → Webhooks → New Webhook
- [ ] Copy URL → `DISCORD_WEBHOOK_URL` in `.env`

## 3. Polymarket (live mode requirement)

**Who:** Parent (KYC requires real ID, must be 18+)

- [ ] Go to https://polymarket.com → "Sign Up"
- [ ] Sign up with email/Google
- [ ] Connect or create a Polymarket wallet (custodial — they manage it)
- [ ] Complete KYC (Persona — driver's license + selfie)
- [ ] Deposit USDC:
  - Easiest: buy on Coinbase, bridge via Polymarket's onramp
  - Alternative: send USDC.e on Polygon directly to your funder address
- [ ] Generate API credentials:
  - Profile (top right) → "API Keys" → "Create"
  - Sign the EIP-712 message in your wallet
  - You'll receive: `api_key`, `secret`, `passphrase`
- [ ] Export wallet private key:
  - Profile → "Export Private Key"
  - **Save securely** — this signs every order
- [ ] Copy your "funder address" from the wallet display
- [ ] Approve USDC spending (one-time):
  - The first manual trade you place will prompt for this approval
  - Or run the approval script (see below) — V2 task

**Add to `.env`:**
```
POLYMARKET_PRIVATE_KEY=0x...
POLYMARKET_FUNDER_ADDRESS=0x...
POLYMARKET_API_KEY=...
POLYMARKET_API_SECRET=...
POLYMARKET_API_PASSPHRASE=...
```

## 4. Kalshi (live mode requirement)

**Who:** Parent (KYC requires SSN, must be 18+)

- [ ] Go to https://kalshi.com → "Sign Up"
- [ ] Provide name + SSN + DOB + address (CFTC-regulated, full KYC)
- [ ] Link bank account via Plaid (for ACH deposits/withdrawals)
- [ ] Deposit funds via ACH — typically instant for verified accounts
- [ ] Generate API credentials:
  - Profile → "API Keys" → "Generate New Key"
  - **Download the private key (.pem)** immediately — you cannot retrieve it later
  - Save to `secrets/kalshi_private_key.pem` (this folder is gitignored)
  - Copy the displayed `API Key ID`
- [ ] Verify by hitting the test endpoint:
  ```bash
  curl -X GET https://api.elections.kalshi.com/trade-api/v2/portfolio/balance \
    -H "KALSHI-ACCESS-KEY: $KALSHI_API_KEY_ID" \
    -H "KALSHI-ACCESS-SIGNATURE: ..." \
    -H "KALSHI-ACCESS-TIMESTAMP: ..."
  ```

**Add to `.env`:**
```
KALSHI_API_KEY_ID=...
KALSHI_PRIVATE_KEY_PATH=./secrets/kalshi_private_key.pem
```

## 5. Fly.io (for production deployment)

- [ ] Sign up at https://fly.io (free tier covers small bots)
- [ ] Install flyctl: `brew install flyctl`
- [ ] `fly auth login`
- [ ] Add payment method (no charge for hobby tier but required)

## 6. Sanity check before flipping to live

- [ ] Paper mode has been running for ≥ 2 weeks
- [ ] At least 50+ paper signals fired across all strategies
- [ ] Paper PnL is positive (or at least breakeven) for each strategy
- [ ] You've intentionally triggered the daily loss cap to verify kill switch works
- [ ] You have a "panic stop" runbook: `fly secrets set TRADING_MODE=paper && fly apps restart pandaxpanther-prediction-bot`
- [ ] Bankroll on each platform is ≤ $1,000 for the first live week
