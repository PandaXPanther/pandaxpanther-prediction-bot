/**
 * STRATEGY: Kalshi Liquidity Incentive Program (LIP) Quoter
 *
 * Passive two-sided maker quoting to earn LIP snapshot rewards and VIP rebates
 * ($0.005/contract). Program ends Sep 1, 2026. NOT directional — but fills create
 * directional exposure; risk controls cancel aggressively.
 *
 * Opt-in: LIP_ENABLED=true | Hard cap: $50 | Fill alert: $20 | 24h loss stop: $30
 */

import axios from 'axios';
import { KalshiConnector } from '../connectors/kalshi.js';
import { recordHeartbeat, recordOrder, upsertMarket, markOrderCancelledByExternalId } from '../db/supabase.js';
import { sendDiscord } from '../utils/discord.js';
import { getConfig, getTradingMode } from '../utils/config.js';
import { createStrategyLogger } from '../utils/logger.js';

const log = createStrategyLogger('liquidity_incentive');

// ─── Constants ────────────────────────────────────────────────────────────────
const REQUOTE_MS         = 60_000;      // re-quote interval
const HEARTBEAT_MS       = 60_000;      // heartbeat interval
const FETCH_TIMEOUT      = 10_000;
const MARKET_LIMIT       = 200;         // markets per API page
const TOP_N_MARKETS      = parseInt(process.env.LIP_TOP_N || '12', 10);  // tuned 2026-05-22: was 5, now 12 to cover more pools
const QUOTE_OFFSET_CENTS = parseFloat(process.env.LIP_QUOTE_OFFSET || '0.01'); // ±1c from best bid/ask
const MIN_QUOTE_PRICE    = 0.03;        // floor — no orders below 3c
const MAX_QUOTE_PRICE    = 0.97;        // ceiling — no orders above 97c
const SIZE_USD_PER_SIDE  = parseFloat(process.env.LIP_SIZE_USD || '15');  // tuned 2026-05-22: was $7, now $15 to approach target_size_fp
const HARD_CAP_USD       = parseFloat(process.env.LIP_HARD_CAP_USD || '150');  // tuned 2026-05-22: was $50, now $150 (~12% of balance)
const FILL_ALERT_USD     = parseFloat(process.env.LIP_FILL_ALERT || '40');  // scaled with cap
const LOSS_STOP_USD      = parseFloat(process.env.LIP_LOSS_STOP || '60');  // scaled with cap
const MIN_VOLUME_24H     = 1_000;       // proxy filter: volume_24h > $1k
const MAX_SPREAD_CENTS   = 0.05;        // proxy filter: spread ≤ 5c (tighter = more LIP-eligible)

// ─── Types ────────────────────────────────────────────────────────────────────
interface LipMarket {
  ticker:     string;
  title:      string;
  yesBid:     number;
  yesAsk:     number;
  volume24h:  number;
  spread:     number;
  // LIP-program metadata (from /incentive_programs)
  programId?:    string;
  rewardUsd?:    number;     // dollars (period_reward / 100)
  targetSizeFp?: number;     // contracts the program wants quoted on each side
  startDate?:    string;
  endDate?:      string;
  // orders we've placed on this market
  bidOrderId?: string;
  askOrderId?: string;
  fillUsd:     number;  // cumulative fill exposure on this market
}

interface ActiveOrder {
  orderId: string;
  ticker:  string;
  side:    'YES' | 'NO';
  price:   number;
  sizeContracts: number;
  placedAt: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const parseD = (v: any, div = 1): number | undefined =>
  v != null && v !== '' ? parseFloat(v) / div : undefined;

async function apiFetch(url: string, params?: Record<string, any>): Promise<any> {
  const r = await axios.get(url, {
    params,
    timeout: FETCH_TIMEOUT,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PandaXPanther-Bot/1.0)' },
    validateStatus: (s) => s < 500,
  });
  return r.data;
}

// ─── Strategy ─────────────────────────────────────────────────────────────────
export class LiquidityIncentiveStrategy {
  readonly name = 'liquidity_incentive';

  private lipMarkets   = new Map<string, LipMarket>();
  private activeOrders = new Map<string, ActiveOrder>();
  /** Exit orders posted by auto-flatten. NEVER cancelled on requote — they should ride until filled.
   *  Tracked separately so we can show them on heartbeats and persist to DB. */
  private exitOrders   = new Map<string, ActiveOrder>();
  private stopped      = false;
  /** Cached LIP program list. Refreshed every PROGRAM_CACHE_MS or on miss. */
  private programCache: any[] = [];
  private programCacheAt = 0;
  private static readonly PROGRAM_CACHE_MS = 5 * 60_000;  // 5 minutes

  // accounting
  private totalDeployed = 0;          // sum of open order notional
  private fills         = 0;          // number of fills this session
  private fillValueUsd  = 0;          // total fill notional
  private lifetimePnl   = 0;          // approximate: VIP rebates - mark-to-market losses
  private losses24h     = 0;          // rolling 24h loss tracker
  private losses24hAt   = Date.now(); // window start

  constructor(private kalshi: KalshiConnector) {}

  async start(): Promise<void> {
      if (process.env.LIP_ENABLED !== 'true') {
      log.info('LIP_ENABLED != true — liquidity incentive strategy is disabled. Set LIP_ENABLED=true to opt in.');
      return;
    }

    log.info('LiquidityIncentiveStrategy starting — passive LIP/VIP yield quoter');
    // CRITICAL: on startup, in-memory activeOrders is empty but Kalshi may have
    // dozens of orphaned LIP orders from prior bot restarts. Pull live open orders
    // and reconcile so we cancel them properly before placing new quotes.
    await this.reconcileOrphanedOrders();
    await this.cancelAllLipOrders('startup cleanup');
    await this.runCycle();

    setInterval(() => { void this.runCycle(); },    REQUOTE_MS);
    setInterval(() => { this.heartbeat(); },         HEARTBEAT_MS);

    log.info('LiquidityIncentiveStrategy running — re-quoting every 60s');
  }

  // ── Main loop ──────────────────────────────────────────────────────────────
  private async runCycle(): Promise<void> {
    if (this.stopped) return;

    // Safety: cancel all if not live
    if (getTradingMode() !== 'live') {
      log.info({ mode: getTradingMode() }, 'LIP: non-live mode — no real orders (logging only)');
      await this.discoverMarkets();
      this.logCandidates();
      return;
    }

    // 24h loss window reset
    if (Date.now() - this.losses24hAt > 24 * 60 * 60 * 1000) {
      this.losses24h = 0;
      this.losses24hAt = Date.now();
    }

    // Stop check
    if (this.losses24h >= LOSS_STOP_USD) {
      if (!this.stopped) {
        this.stopped = true;
        log.error({ losses24h: this.losses24h }, 'LIP: 24h loss cap hit — strategy halted');
        await this.cancelAllLipOrders('24h loss cap');
        void sendDiscord('LIP strategy halted — 24h loss cap', `Losses: $${this.losses24h.toFixed(2)} >= $${LOSS_STOP_USD}`, 'warn', []);
      }
      return;
    }

    // Re-sync activeOrders from Kalshi reality at the start of every cycle. The
    // boot reconciler isn't enough — if any order is placed and not tracked
    // (network race, crash, etc.) it'll orphan. This catches and cancels them.
    await this.reconcileOrphanedOrders().catch(e => log.warn({ err: e.message }, 'cycle reconcile failed'));
    // Reorder to minimize the quoting gap each cycle:
    //   1. Discover markets (5-15s API)
    //   2. THEN cancel old quotes
    //   3. THEN immediately post new ones
    await this.discoverMarkets();
    if (this.lipMarkets.size === 0) {
      log.warn('LIP: discovery returned 0 markets, NOT cancelling existing quotes this cycle');
      return;
    }
    // Also sweep any positions held on LIP-eligible tickers — auto-flatten them.
    // Catches stuck positions from before late-fill detection was wired up.
    await this.flattenStuckPositions().catch(e => log.warn({ err: e.message }, 'flattenStuckPositions failed'));
    await this.cancelAllLipOrders('requote');
    await this.placeQuotes();
  }

  /**
   * Post break-even SELL for any position held on a LIP-eligible ticker that
   * doesn't already have a matching exitOrder. Idempotent: if we already posted
   * an exit at this price for this ticker+side, skip.
   */
  private async flattenStuckPositions(): Promise<void> {
    if (this.lipMarkets.size === 0) return;
    let positions: any[];
    try {
      positions = await this.kalshi.tryGetPositions();
    } catch (e: any) {
      log.debug({ err: e.message }, 'LIP: getPositions failed in flattenStuckPositions');
      return;
    }
    // 2026-05-22: HARD EXCLUDE political markets. LIP was repeatedly flattening
    // (and re-buying) on KXAPRPOTUS / KXVOTEHUB markets where the user had
    // manual positions and manually-placed sell orders. These markets are
    // illiquid, multi-day-resolving, and not where we want LIP capital. Any
    // ticker matching these prefixes is treated as user-managed.
    const POLITICAL_EXCLUDE = ['KXAPRPOTUS', 'KXVOTEHUB', 'KXPRESPERSON', 'KXNEXTAG', 'KXPRES', 'KXNEXTPOTUS'];

    // Build a set of LIP-eligible series prefixes (e.g. KXLOWTLAX, KXRAINNYC, etc.)
    // Positions on ANY ticker matching these prefixes were placed by LIP and should be flattened.
    // This catches positions on strike levels we're no longer actively quoting.
    const lipSeriesPrefixes = new Set<string>();
    for (const t of this.lipMarkets.keys()) {
      const prefix = t.split('-')[0];
      if (prefix && !POLITICAL_EXCLUDE.includes(prefix)) lipSeriesPrefixes.add(prefix);
    }
    // Also seed with prefixes from the cached program list — covers tickers that were
    // LIP-eligible at the time of fill but rotated out of current quote selection.
    for (const p of this.programCache) {
      const prefix = String(p?.market_ticker ?? '').split('-')[0];
      if (prefix && !POLITICAL_EXCLUDE.includes(prefix)) lipSeriesPrefixes.add(prefix);
    }
    log.info({ prefixes: [...lipSeriesPrefixes].slice(0, 8), positions: positions.length,
               sample: positions.slice(0, 3) }, 'LIP: stuck-position sweep starting');
    for (const pos of positions) {
      const ticker = String(pos?.ticker ?? '');
      const seriesPrefix = ticker.split('-')[0];
      if (!lipSeriesPrefixes.has(seriesPrefix)) continue;  // not a LIP series — don't touch (could be user position)
      // Kalshi reports `position` field: positive = long YES, negative = long NO
      const qty = Number(pos?.position ?? 0);
      if (qty === 0) continue;
      const side: 'YES' | 'NO' = qty > 0 ? 'YES' : 'NO';
      const absQty = Math.abs(qty);
      // Skip if we already have an exitOrder for this ticker+side
      const existing = [...this.exitOrders.values()].find(o => o.ticker === ticker && o.side === side);
      if (existing) {
        log.debug({ ticker, side, qty: absQty, existingExitId: existing.orderId }, 'LIP: position already has exit order, skipping');
        continue;
      }
      // Look up avg fill price from the position record — Kalshi reports `position_cost_dollars` and `position`
      const costDollars = parseFloat(pos?.position_cost_dollars ?? pos?.market_exposure_dollars ?? '0');
      const avgPrice = absQty > 0 ? Math.abs(costDollars) / absQty : 0;
      if (avgPrice <= 0 || avgPrice >= 1) {
        log.warn({ ticker, qty, costDollars, avgPrice }, 'LIP: stuck position has bogus avgPrice, skipping flatten');
        continue;
      }
      const exitPrice = Math.max(0.01, Math.min(0.99, Math.round(avgPrice * 100) / 100));
      try {
        const exitResult = await this.kalshi.placeOrder({
          platform: 'kalshi',
          externalId: ticker,
          outcome: side,
          side: 'SELL',
          orderType: 'limit',
          price: exitPrice,
          size: absQty,
          clientOrderIdPrefix: 'lip-exit',
        } as any);
        if (exitResult.ok && exitResult.externalOrderId) {
          this.exitOrders.set(exitResult.externalOrderId, {
            orderId: exitResult.externalOrderId,
            ticker,
            side,
            price: exitPrice,
            sizeContracts: absQty,
            placedAt: Date.now(),
          });
          log.info({ ticker, side, qty: absQty, avgPrice, exitPrice, exitOrderId: exitResult.externalOrderId },
                   '🔄 LIP: auto-flatten posted for stuck position');
          void sendDiscord('LIP stuck-position flatten',
            `${ticker} ${side} ${absQty}@${avgPrice.toFixed(2)} → SELL ${absQty}@${exitPrice.toFixed(2)}`,
            'info');
        } else {
          log.warn({ ticker, err: exitResult.error }, 'LIP: stuck-position flatten REJECTED');
        }
      } catch (e: any) {
        log.warn({ err: e.message, ticker }, 'LIP: stuck-position flatten threw');
      }
    }
  }

  /**
   * REAL LIP discovery: pulls the official program list from Kalshi's public
   * /trade-api/v2/incentive_programs endpoint, filters to currently-active
   * programs only, then fetches live bid/ask for each. Ranks by reward/active-min
   * ratio so high-payout-per-minute markets quote first.
   *
   * (Previously this used a vol+spread heuristic and — we discovered — quoted
   * markets that were NOT in the LIP program at all. Result: $0 lifetime rewards.)
   */
  private async discoverMarkets(): Promise<void> {
    this.lipMarkets.clear();
    try {
      // 1) Fetch official LIP program list (cached to avoid downtime from API hiccups).
      let allPrograms: any[] = [];
      const cacheAge = Date.now() - this.programCacheAt;
      if (this.programCache.length > 0 && cacheAge < LiquidityIncentiveStrategy.PROGRAM_CACHE_MS) {
        allPrograms = this.programCache;
        log.debug({ cacheAgeMs: cacheAge, programs: allPrograms.length }, 'LIP: using cached program list');
      } else {
        try {
          const progData = await apiFetch('https://api.elections.kalshi.com/trade-api/v2/incentive_programs', { limit: 200 });
          allPrograms = progData?.incentive_programs ?? [];
          if (allPrograms.length > 0) {
            this.programCache = allPrograms;
            this.programCacheAt = Date.now();
          } else if (this.programCache.length > 0) {
            log.warn('LIP: program API returned empty, falling back to cache');
            allPrograms = this.programCache;
          }
        } catch (e: any) {
          if (this.programCache.length > 0) {
            log.warn({ err: e.message, cacheAgeMin: (cacheAge / 60_000).toFixed(1) }, 'LIP: program API failed, using stale cache');
            allPrograms = this.programCache;
          } else {
            throw e;
          }
        }
      }
      const nowMs = Date.now();
      // 2026-05-22: HARD EXCLUDE political markets from LIP entirely. These are
      // multi-day-resolving, low-liquidity bets that don't suit LIP's
      // quote-and-flatten model and conflict with manually-placed user orders.
      const POLITICAL_EXCLUDE = ['KXAPRPOTUS', 'KXVOTEHUB', 'KXPRESPERSON', 'KXNEXTAG', 'KXPRES', 'KXNEXTPOTUS'];
      const active = allPrograms.filter(p => {
        const start = Date.parse(p.start_date);
        const end   = Date.parse(p.end_date);
        if (!(start <= nowMs && nowMs <= end)) return false;
        const ticker = String(p.market_ticker ?? '');
        const prefix = ticker.split('-')[0];
        if (POLITICAL_EXCLUDE.includes(prefix)) return false;
        return true;
      });
      log.info({ totalPrograms: allPrograms.length, activeNow: active.length, politicalExcluded: POLITICAL_EXCLUDE }, 'LIP: fetched incentive program list');
      if (active.length === 0) {
        log.warn('LIP: zero active programs right now — nothing to quote this cycle');
        return;
      }

      // 2) De-duplicate: a single market can have multiple programs; pick highest-reward.
      const byTicker = new Map<string, any>();
      for (const p of active) {
        const t = p.market_ticker;
        if (!byTicker.has(t) || (p.period_reward ?? 0) > (byTicker.get(t).period_reward ?? 0)) {
          byTicker.set(t, p);
        }
      }

      // 3) Rank by reward $ / target_size (best $-per-contract-quoted ratio first).
      const ranked = [...byTicker.values()].sort((a, b) => {
        const ra = (a.period_reward ?? 0) / Math.max(1, parseFloat(a.target_size_fp ?? '1'));
        const rb = (b.period_reward ?? 0) / Math.max(1, parseFloat(b.target_size_fp ?? '1'));
        return rb - ra;
      });

      // 4) Fetch live bid/ask for the top candidates. Stop after we have TOP_N viable markets.
      let attempted = 0;
      for (const p of ranked) {
        if (this.lipMarkets.size >= TOP_N_MARKETS) break;
        if (attempted++ > TOP_N_MARKETS * 4) break; // bound API hits per cycle
        const ticker = p.market_ticker as string;
        try {
          const data = await apiFetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${encodeURIComponent(ticker)}`);
          const mk = data?.market;
          if (!mk) continue;
          const yesBid = parseD(mk.yes_bid_dollars) ?? parseD(mk.yes_bid, 100);
          const yesAsk = parseD(mk.yes_ask_dollars) ?? parseD(mk.yes_ask, 100);
          const vol24h = parseD(mk.volume_24h_fp) ?? parseD(mk.volume_24h_dollars) ?? parseD(mk.volume_24h, 100) ?? 0;
          if (yesBid == null || yesAsk == null || yesBid <= 0 || yesAsk <= 0) continue;
          if (yesAsk < MIN_QUOTE_PRICE || yesBid > MAX_QUOTE_PRICE) continue;
          const spread = yesAsk - yesBid;
          this.lipMarkets.set(ticker, {
            ticker,
            title:        mk.title ?? ticker,
            yesBid, yesAsk, volume24h: vol24h, spread,
            programId:    p.id,
            rewardUsd:    (p.period_reward ?? 0) / 100,
            targetSizeFp: parseFloat(p.target_size_fp ?? '0') || undefined,
            startDate:    p.start_date,
            endDate:      p.end_date,
            fillUsd: 0,
          });
        } catch (e: any) {
          log.debug({ ticker, err: e.message }, 'LIP: failed to fetch market book');
        }
      }

      log.info({
        active: active.length,
        uniqueTickers: byTicker.size,
        selected: this.lipMarkets.size,
        top: [...this.lipMarkets.values()].map(m => ({
          t: m.ticker.slice(0, 28), reward: m.rewardUsd, target: m.targetSizeFp,
          spread: m.spread.toFixed(3),
        })),
      }, 'LIP: market discovery complete (real programs)');
    } catch (e: any) {
      log.warn({ err: e.message }, 'LIP: incentive program fetch failed — no markets this cycle');
    }
  }

  /** C-6 fix: shared abort signal — postOrder sets this to true on picked-off fill */
  private abortCycle = false;

  private async placeQuotes(): Promise<void> {
    this.abortCycle = false;
    let deployed = 0;

    for (const m of this.lipMarkets.values()) {
      if (this.abortCycle) {
        log.warn('LIP: cycle aborted due to fill-alert — stopping further quotes');
        break;
      }
      if (deployed >= HARD_CAP_USD) {
        log.warn({ deployed }, 'LIP: hard cap reached — skipping remaining markets');
        break;
      }

      // Re-fetch live book for this market
      await this.refreshBook(m);

      const spread = m.yesAsk - m.yesBid;
      // If spread is wide (>=3c), improve by 1c on each side (be the new best bid/ask).
      // If spread is tight (1-2c), JOIN the existing best bid/ask — still earns LIP
      // snapshot rewards (resting maker volume at top of book) and VIP rebates on fills.
      let bidPrice: number, askPrice: number;
      if (spread >= 0.03) {
        bidPrice = parseFloat((m.yesBid + QUOTE_OFFSET_CENTS).toFixed(2));
        askPrice = parseFloat((m.yesAsk - QUOTE_OFFSET_CENTS).toFixed(2));
      } else {
        // Join existing top of book — still maker, still snapshot-eligible
        bidPrice = parseFloat(m.yesBid.toFixed(2));
        askPrice = parseFloat(m.yesAsk.toFixed(2));
      }

      // Guard: prices must be valid and not inverted
      if (bidPrice >= askPrice) continue;
      if (bidPrice < MIN_QUOTE_PRICE || bidPrice > MAX_QUOTE_PRICE) continue;
      if (askPrice < MIN_QUOTE_PRICE || askPrice > MAX_QUOTE_PRICE) continue;

      const remainingCap  = HARD_CAP_USD - deployed;
      const sideUsd       = Math.min(SIZE_USD_PER_SIDE, remainingCap / 2);
      if (sideUsd < 1) break;

      // YES bid (we buy YES at bidPrice — better than best bid)
      const yesSizeContracts = Math.max(1, Math.floor(sideUsd / bidPrice));
      await this.postOrder(m, 'YES', bidPrice, yesSizeContracts);
      deployed += yesSizeContracts * bidPrice;

      // NO bid (we buy NO at 1 - askPrice — better than best ask for sellers)
      const noPrice          = parseFloat((1 - askPrice).toFixed(2));
      if (noPrice >= MIN_QUOTE_PRICE && noPrice <= MAX_QUOTE_PRICE) {
        const noSizeContracts  = Math.max(1, Math.floor(sideUsd / noPrice));
        await this.postOrder(m, 'NO', noPrice, noSizeContracts);
        deployed += noSizeContracts * noPrice;
      }

      await new Promise((r) => setTimeout(r, 150)); // rate-limit gap
    }

    this.totalDeployed = deployed;
    log.info({ deployed: deployed.toFixed(2), markets: this.lipMarkets.size }, 'LIP: quotes placed');
  }

  private async postOrder(m: LipMarket, side: 'YES' | 'NO', price: number, sizeContracts: number): Promise<void> {
    try {
      const result = await this.kalshi.placeOrder({
        platform: 'kalshi',
        externalId: m.ticker,
        outcome: side,
        side: 'BUY',
        orderType: 'limit',
        price,
        size: sizeContracts,
        clientOrderIdPrefix: 'lip',  // CRIT-3 fix: distinguish LIP orders from other strategies on reconcile
      } as any);

      if (result.ok && result.externalOrderId) {
        const order: ActiveOrder = {
          orderId: result.externalOrderId,
          ticker: m.ticker,
          side,
          price,
          sizeContracts,
          placedAt: Date.now(),
        };
        this.activeOrders.set(result.externalOrderId, order);

        // Persist to DB so dashboard + audit can track LIP orders
        try {
          const mid = await upsertMarket({
            platform: 'kalshi',
            external_id: m.ticker,
            question: m.title || m.ticker,
            category: 'liquidity_incentive',
          });
          if (mid) {
            const filled = result.filled ?? 0;
            await recordOrder({
              market_id: mid,
              strategy: 'liquidity_incentive',
              mode: 'live',
              side: 'BUY',
              order_type: 'LIMIT',
              price,
              size: sizeContracts,
              filled_size: filled,
              outcome: side,
              external_order_id: result.externalOrderId,
              status: filled >= sizeContracts ? 'filled' : (filled > 0 ? 'partial' : 'open'),
            });
          }
        } catch (e: any) {
          log.debug({ err: e.message }, 'LIP: recordOrder failed (non-fatal)');
        }
        if (side === 'YES') m.bidOrderId = result.externalOrderId;
        else                m.askOrderId = result.externalOrderId;

        const filled = result.filled ?? 0;
        if (filled > 0) {
          const fillUsd = filled * price;
          this.fills++;
          this.fillValueUsd += fillUsd;
          m.fillUsd += fillUsd;
          // VIP rebate credit: $0.005/contract
          this.lifetimePnl += filled * 0.005;

          // ============ AUTO-FLATTEN AT BREAK-EVEN ============
          // When a LIP quote fills, we now own `filled` contracts at `price`.
          // Post an immediate LIMIT SELL at the same price (break-even) so the
          // position closes whenever the book ticks back through our level.
          // This converts "stuck with directional exposure" into "flat at b/e".
          // Failure non-fatal: we still hold the position and can flatten manually.
          try {
            // SELL at the same price: Kalshi rounds to 1¢ grid; ensure within [0.01, 0.99].
            const exitPrice = Math.max(0.01, Math.min(0.99, Math.round(price * 100) / 100));
            const exitResult = await this.kalshi.placeOrder({
              platform: 'kalshi',
              externalId: m.ticker,
              outcome: side,
              side: 'SELL',
              orderType: 'limit',
              price: exitPrice,
              size: filled,
              clientOrderIdPrefix: 'lip-exit',
            } as any);
            if (exitResult.ok) {
              log.info({ ticker: m.ticker, side, filled, exitPrice, exitOrderId: exitResult.externalOrderId },
                'LIP: auto-flatten SELL posted at break-even');
              // Track in exitOrders — NOT activeOrders — so cancelAllLipOrders('requote')
              // doesn't wipe out our exit ticket. Exits persist until filled or manually cancelled.
              if (exitResult.externalOrderId) {
                this.exitOrders.set(exitResult.externalOrderId, {
                  orderId: exitResult.externalOrderId,
                  ticker: m.ticker,
                  side,
                  price: exitPrice,
                  sizeContracts: filled,
                  placedAt: Date.now(),
                });
              }
              // Also notify Discord so user sees the fill + exit pair in real time
              // Make it explicit: this SELL is RESTING, not filled. It will only fill
              // if someone hits the bid at our break-even level. Otherwise the 2hr
              // safety valve will force-close at market.
              void sendDiscord('LIP fill + break-even exit posted',
                `BOUGHT ${side} ${filled}@${price.toFixed(2)} — you OWN this position now.\nResting SELL @${exitPrice.toFixed(2)} (break-even). Will fill ONLY if someone hits the bid.\n${m.ticker}`,
                'info');
            } else {
              log.warn({ ticker: m.ticker, err: exitResult.error }, 'LIP: auto-flatten SELL rejected');
            }
          } catch (exitErr: any) {
            log.warn({ err: exitErr.message, ticker: m.ticker }, 'LIP: auto-flatten error (non-fatal, position remains)');
          }

          // Picked-off guard: cancel everything if fill > $20 on this market
          if (m.fillUsd > FILL_ALERT_USD) {
            log.warn({ ticker: m.ticker, fillUsd: m.fillUsd }, 'LIP: fill alert — cancelling all LIP orders (picked off)');
            void sendDiscord('LIP fill alert — picked off!',
              `${m.ticker} fill: $${m.fillUsd.toFixed(2)} > $${FILL_ALERT_USD} threshold`, 'warn',
              [{ name: 'Market', value: m.ticker, inline: true }, { name: 'Fill $', value: m.fillUsd.toFixed(2), inline: true }]);
            this.losses24h += fillUsd;
            await this.cancelAllLipOrders('fill alert — picked off');
            // C-6 fix: signal placeQuotes loop to stop iterating other markets in this cycle
            this.abortCycle = true;
            return;
          }

          log.info({ ticker: m.ticker, side, filled, fillUsd: fillUsd.toFixed(2) }, 'LIP: order partially/fully filled (VIP rebate earned)');
        }

        log.debug({ ticker: m.ticker, side, price, sizeContracts, orderId: result.externalOrderId }, 'LIP: order posted');
      } else {
        log.warn({ ticker: m.ticker, side, price, err: result.error }, 'LIP: order rejected');
      }
    } catch (e: any) {
      log.warn({ err: e.message, ticker: m.ticker, side }, 'LIP: postOrder error');
    }
  }

  /**
   * Reconcile orphaned orders left over from prior bot restarts.
   * On startup, in-memory `activeOrders` is empty but Kalshi may have many
   * LIP-style orders still resting. We pull live open orders, identify any
   * that look like LIP quotes (small size, two-sided market) and add them
   * to activeOrders so the subsequent cancelAllLipOrders() can clean them up.
   * Without this, every restart adds another layer of duplicate quotes.
   */
  private async reconcileOrphanedOrders(): Promise<void> {
    try {
      const openOrders = await this.kalshi.getOpenOrders();
      log.info({ kalshiOpenOrders: openOrders.length }, 'LIP: reconciling orphaned orders on startup');
      let adopted = 0, legacyAdopted = 0;

      // ============ LATE-FILL DETECTION (audit critical fix 2026-05-22) ============
      // Snapshot activeOrders BEFORE we rebuild from Kalshi reality. Any order in the
      // snapshot but missing from Kalshi (or with reduced remaining_count) has filled.
      // For each detected fill, we post an immediate break-even SELL (auto-flatten).
      // Without this, resting-quote fills happen invisibly and positions stack up.
      const prevActive = new Map(this.activeOrders);
      const kalshiRemaining = new Map<string, number>();
      for (const o of openOrders as any[]) {
        if (!o?.order_id) continue;
        const sz = parseFloat(o.remaining_count_fp ?? '') ||
                   Number(o.remaining_count ?? o.count ?? 0);
        kalshiRemaining.set(o.order_id, sz);
      }
      // Reset before re-adopting; we rebuild from kalshi reality below.
      this.activeOrders.clear();
      // C-5 fix: legacy orders placed before the 'lip-' prefix existed need a one-time
      // adoption based on the ticker heuristic. Only orders OLDER than the deploy cutoff
      // qualify so we never accidentally adopt sports CLV's freshly-placed orders.
      const LEGACY_CUTOFF_MS = new Date('2026-05-22T19:30:00Z').getTime();

      for (const o of openOrders as any[]) {
        if (!o?.order_id) continue;
        const cid = String(o.client_order_id || '');
        // CRITICAL FIX (audit follow-up): Kalshi /portfolio/orders returns string-decimal
        // fields (remaining_count_fp, yes_price_dollars), NOT the int-cents fields
        // (remaining_count, yes_price). The old code read the missing fields and got 0,
        // which made `sz < 1` skip ALL orders — the reconciler never adopted anything,
        // so cancelAllLipOrders had an empty set and stale orders piled up on Kalshi.
        const sz =
          parseFloat(o.remaining_count_fp ?? '') ||
          Number(o.remaining_count ?? o.count ?? 0);
        if (sz < 1) continue;
        const yesPxStr = o.yes_price_dollars;
        const noPxStr  = o.no_price_dollars;
        const priceDollars =
          (o.side === 'yes' && yesPxStr) ? parseFloat(yesPxStr) :
          (o.side === 'no'  && noPxStr)  ? parseFloat(noPxStr)  :
          Number(o.yes_price ?? o.no_price ?? o.price ?? 0) / 100;

        // PRIMARY: strict client_order_id match. Note that `lip-exit-*` orders
        // are SELLs from auto-flatten — they must go into exitOrders, NOT
        // activeOrders, or the requote-cycle would cancel them.
        if (cid.startsWith('lip-exit-')) {
          this.exitOrders.set(o.order_id, {
            orderId: o.order_id,
            ticker: String(o.ticker || ''),
            side: (o.side === 'yes' ? 'YES' : 'NO'),
            price: priceDollars,
            sizeContracts: sz,
            placedAt: o.created_time ? new Date(o.created_time).getTime() : Date.now() - 60_000,
          });
          adopted++;
          continue;
        }
        if (cid.startsWith('lip-')) {
          this.activeOrders.set(o.order_id, {
            orderId: o.order_id,
            ticker: String(o.ticker || ''),
            side: (o.side === 'yes' ? 'YES' : 'NO'),
            price: priceDollars,
            sizeContracts: sz,
            placedAt: o.created_time ? new Date(o.created_time).getTime() : Date.now() - 60_000,
          });
          adopted++;
          continue;
        }

        // LEGACY: orders placed BEFORE the prefix existed (created before cutoff).
        // Use the old ticker-prefix heuristic, but only for OLD orders.
        const createdTime = o.created_time ? new Date(o.created_time).getTime() : 0;
        if (createdTime > 0 && createdTime < LEGACY_CUTOFF_MS) {
          const ticker = String(o.ticker || '');
          const looksLikeLip =
            (ticker.startsWith('KXPRES') || ticker.startsWith('KXNEXTAG')) &&
            sz <= 100 &&
            o.action === 'buy' && o.type === 'limit';
          if (looksLikeLip) {
            this.activeOrders.set(o.order_id, {
              orderId: o.order_id, ticker,
              side: (o.side === 'yes' ? 'YES' : 'NO'),
              price: priceDollars,
              sizeContracts: sz,
              placedAt: createdTime,
            });
            legacyAdopted++;
          }
        }
      }
      log.info({ adopted, legacyAdopted, totalOpen: openOrders.length },
        'LIP: orphaned orders adopted (strict + legacy)');

      // ============ DETECT FILLS (continued) ============
      // Compare prev vs now. Any prev entry with reduced size = filled.
      const detectedFills: { ticker: string; side: 'YES'|'NO'; price: number; filled: number }[] = [];
      for (const [orderId, prev] of prevActive) {
        const nowRemaining = kalshiRemaining.get(orderId) ?? 0; // 0 = order gone entirely
        const filled = prev.sizeContracts - nowRemaining;
        if (filled > 0) {
          detectedFills.push({ ticker: prev.ticker, side: prev.side, price: prev.price, filled });
          log.info({ orderId, ticker: prev.ticker, side: prev.side, price: prev.price,
                     filledFp: filled, prevSize: prev.sizeContracts, nowRemaining },
                   '🔔 LIP: detected LATE FILL on resting quote');
        }
      }
      if (detectedFills.length > 0) {
        // Auto-flatten each filled position with a break-even SELL.
        for (const fill of detectedFills) {
          this.fills++;
          const fillUsd = fill.filled * fill.price;
          this.fillValueUsd += fillUsd;
          this.lifetimePnl += fill.filled * 0.005;  // VIP rebate credit
          try {
            const exitPrice = Math.max(0.01, Math.min(0.99, Math.round(fill.price * 100) / 100));
            const exitResult = await this.kalshi.placeOrder({
              platform: 'kalshi',
              externalId: fill.ticker,
              outcome: fill.side,
              side: 'SELL',
              orderType: 'limit',
              price: exitPrice,
              size: fill.filled,
              clientOrderIdPrefix: 'lip-exit',
            } as any);
            if (exitResult.ok && exitResult.externalOrderId) {
              this.exitOrders.set(exitResult.externalOrderId, {
                orderId: exitResult.externalOrderId,
                ticker: fill.ticker,
                side: fill.side,
                price: exitPrice,
                sizeContracts: fill.filled,
                placedAt: Date.now(),
              });
              log.info({ ticker: fill.ticker, filled: fill.filled, exitPrice, exitOrderId: exitResult.externalOrderId },
                       '✅ LIP: late-fill auto-flatten posted');
              void sendDiscord('LIP late-fill + break-even exit posted',
                `BOUGHT ${fill.side} ${fill.filled}@${fill.price.toFixed(2)} — you OWN this position now.\nResting SELL @${exitPrice.toFixed(2)} (break-even). Will fill ONLY if someone hits the bid.\n${fill.ticker}`,
                'info');
            } else {
              log.warn({ ticker: fill.ticker, err: exitResult.error }, 'LIP: late-fill auto-flatten REJECTED');
              void sendDiscord('⚠️ LIP auto-flatten failed',
                `${fill.ticker} ${fill.side} ${fill.filled}@${fill.price.toFixed(2)} — exit order rejected. Position held.`, 'warn');
            }
          } catch (e: any) {
            log.warn({ err: e.message, ticker: fill.ticker }, 'LIP: late-fill auto-flatten threw');
          }
        }
      }
    } catch (e: any) {
      // H-5 fix: if we can't enumerate Kalshi open orders, we can't safely place new
      // quotes — fresh orders would layer on top of invisible orphans. Halt + alert.
      log.error({ err: e.message }, 'LIP: reconcile orphaned orders FAILED — halting strategy');
      this.stopped = true;
      try {
        await sendDiscord(
          '🛑 LIP strategy halted — reconcile failed',
          `<@572590897150296083> LIP could not enumerate Kalshi open orders on startup (${e.message}). Strategy halted to avoid stacking quotes on invisible orphans. Investigate before re-enabling.`,
          'error',
          [],
        );
      } catch {}
    }
  }

  private async cancelAllLipOrders(reason: string): Promise<void> {
    if (this.activeOrders.size === 0) return;
    log.info({ count: this.activeOrders.size, reason }, 'LIP: cancelling all open orders');
    const cancels = [...this.activeOrders.keys()].map(async (orderId) => {
      try {
        await this.kalshi.cancelOrder(orderId);
        this.activeOrders.delete(orderId);
        // Audit M-5 fix: keep Supabase in sync so DB doesn't accumulate stale 'open' rows.
        // Best-effort; failure is non-fatal.
        await markOrderCancelledByExternalId(orderId, reason).catch(() => null);
      } catch (e: any) {
        // Already filled or expired — not an error in context
        log.debug({ orderId, err: e.message }, 'LIP: cancel failed (may be already filled)');
        this.activeOrders.delete(orderId); // remove anyway to avoid stale tracking
        // Even on cancel failure, the order is probably gone (filled/expired); mark cancelled.
        await markOrderCancelledByExternalId(orderId, `${reason} (cancel-failed)`).catch(() => null);
      }
    });
    await Promise.allSettled(cancels);
    this.totalDeployed = 0;
  }

  private async refreshBook(m: LipMarket): Promise<void> {
    try {
      const data = await apiFetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${m.ticker}`);
      const mk = data?.market;
      if (!mk) return;
      const yesBid = parseD(mk.yes_bid_dollars) ?? parseD(mk.yes_bid, 100);
      const yesAsk = parseD(mk.yes_ask_dollars) ?? parseD(mk.yes_ask, 100);
      if (yesBid != null) m.yesBid = yesBid;
      if (yesAsk != null) m.yesAsk = yesAsk;
      if (yesBid != null && yesAsk != null) m.spread = yesAsk - yesBid;
    } catch { /* stale quotes: use cached values */ }
  }

  private logCandidates(): void {
    if (this.lipMarkets.size === 0) {
      log.info('LIP [paper]: no candidate markets found this cycle');
      return;
    }
    for (const m of this.lipMarkets.values()) {
      const bidPrice = parseFloat((m.yesBid + QUOTE_OFFSET_CENTS).toFixed(2));
      const askPrice = parseFloat((m.yesAsk - QUOTE_OFFSET_CENTS).toFixed(2));
      log.info({
        ticker: m.ticker, vol24h: m.volume24h.toFixed(0),
        spread: (m.spread * 100).toFixed(1) + 'c',
        wouldBid: bidPrice, wouldAsk: askPrice,
      }, 'LIP [paper]: candidate market');
    }
  }

  private heartbeat(): void {
    const payload = {
      lipMarkets:    this.lipMarkets.size,
      activeOrders:  this.activeOrders.size,
      exitOrders:    this.exitOrders.size,
      totalDeployed: parseFloat(this.totalDeployed.toFixed(2)),
      fills:         this.fills,
      fillValueUsd:  parseFloat(this.fillValueUsd.toFixed(2)),
      lifetimePnl:   parseFloat(this.lifetimePnl.toFixed(2)),
      losses24h:     parseFloat(this.losses24h.toFixed(2)),
      stopped:       this.stopped,
      lipEnabled:    process.env.LIP_ENABLED === 'true',
    };
    log.info(payload, 'LIP heartbeat');
    void recordHeartbeat(this.name, getConfig().TRADING_MODE, payload);
    // Run the safety valve every heartbeat tick (~60s) as a side-task.
    void this.checkExitSafetyValve().catch(e => log.warn({ err: e.message }, 'safety-valve threw'));
  }

  /**
   * Safety valve: if an exit order has been resting longer than EXIT_MAX_AGE_MS
   * without filling, cancel it and post a more aggressive sell (1¢ below the
   * current bid). This bounds the worst-case hold-to-settlement loss.
   *
   * Only triggers if the position is meaningful (≥ 5 contracts) — ignores tiny
   * 1-2 contract dust.
   */
  private async checkExitSafetyValve(): Promise<void> {
    const EXIT_MAX_AGE_MS = parseInt(process.env.LIP_EXIT_MAX_AGE_MIN || '120', 10) * 60_000; // default 2 hours
    const MIN_SIZE_TO_FORCE = parseInt(process.env.LIP_FORCE_CLOSE_MIN_SIZE || '5', 10);
    if (this.exitOrders.size === 0) return;
    const now = Date.now();
    const stale: ActiveOrder[] = [];
    for (const exit of this.exitOrders.values()) {
      if (now - exit.placedAt > EXIT_MAX_AGE_MS && exit.sizeContracts >= MIN_SIZE_TO_FORCE) {
        stale.push(exit);
      }
    }
    if (stale.length === 0) return;
    log.warn({ count: stale.length, totalContracts: stale.reduce((s, e) => s + e.sizeContracts, 0) },
             '⚠️ LIP safety valve: stale exit orders — force-closing more aggressively');
    for (const exit of stale) {
      try {
        // 1) Cancel the original break-even SELL
        await this.kalshi.cancelOrder(exit.orderId).catch(() => null);
        this.exitOrders.delete(exit.orderId);
        // 2) Fetch fresh book to find current bid
        const data = await apiFetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${encodeURIComponent(exit.ticker)}`);
        const mk = data?.market;
        if (!mk) {
          log.warn({ ticker: exit.ticker }, 'safety valve: no market data — keeping position');
          continue;
        }
        const yesBid = parseFloat(mk.yes_bid_dollars ?? '') || (mk.yes_bid ?? 0) / 100;
        const noBid  = parseFloat(mk.no_bid_dollars  ?? '') || (mk.no_bid  ?? 0) / 100;
        const sellBid = exit.side === 'YES' ? yesBid : noBid;
        if (!sellBid || sellBid <= 0.01) {
          log.warn({ ticker: exit.ticker, side: exit.side, sellBid }, 'safety valve: no live bid — holding to settlement');
          continue;
        }
        // 3) Post aggressive SELL at the bid (will likely take immediately = pays taker fee)
        const aggressivePrice = Math.max(0.01, sellBid);
        const result = await this.kalshi.placeOrder({
          platform: 'kalshi', externalId: exit.ticker, outcome: exit.side,
          side: 'SELL', orderType: 'limit', price: aggressivePrice,
          size: exit.sizeContracts, clientOrderIdPrefix: 'lip-force',
        } as any);
        const realizedLoss = (exit.price - aggressivePrice) * exit.sizeContracts;
        if (result.ok) {
          log.info({ ticker: exit.ticker, side: exit.side, contracts: exit.sizeContracts,
                     entryPrice: exit.price, forcePrice: aggressivePrice,
                     realizedLoss: realizedLoss.toFixed(2) },
                   '🔴 LIP safety valve: force-close posted');
          this.losses24h += Math.max(0, realizedLoss);
          void sendDiscord('🔴 LIP force-close',
            `${exit.ticker} ${exit.side} ${exit.sizeContracts} @ ${aggressivePrice.toFixed(2)} (entry ${exit.price.toFixed(2)}, age >${(EXIT_MAX_AGE_MS/60_000).toFixed(0)}min). Realized loss ~$${realizedLoss.toFixed(2)}.`,
            'warn');
        }
      } catch (e: any) {
        log.warn({ err: e.message, ticker: exit.ticker }, 'safety valve threw');
      }
    }
  }
}
