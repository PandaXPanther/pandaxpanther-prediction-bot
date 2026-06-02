// Watchdog: ensures the bot's heartbeat loop is actually firing AND that
// outbound network is healthy. Triple-check design:
//
//   (A) Heartbeat watchdog — if strategy code stops calling touchHeartbeat()
//       for STALE_MS, force process.exit(1). Detects event-loop wedge.
//
//   (B) Price-feed staleness watchdog — if no price tick has arrived from ANY
//       provider (WS or REST) in PRICE_STALE_MS, force exit. Detects outbound
//       network stalls even when heartbeats keep ticking.
//
//   (C) Supabase write watchdog — if >SB_FAIL_THRESHOLD consecutive Supabase
//       inserts fail, force exit. Detects database-side or DNS hangs.
//
// Fly's `restart.policy = "always"` will bring the machine back up in seconds
// with a fresh network stack — our largest observed restart time is ~25s.
//
// On exit, the watchdog ALSO pings Discord (best-effort, fire-and-forget) so
// the operator sees the restart in real time.

import http from 'node:http';
import { logger } from './logger.js';
import { sendDiscord } from './discord.js';
import { getSupabaseHealth } from '../db/supabase.js';

// Heartbeat staleness threshold.
const STALE_MS = 180_000; // 3 minutes
const CHECK_INTERVAL_MS = 30_000; // check every 30s
const HEALTH_PORT = 8080;

// Network-stall thresholds (set by setNetworkHealthSources).
const PRICE_STALE_MS = 120_000; // 2 min without ANY tick = outbound network dead
const SB_FAIL_THRESHOLD = 8; // 8 consecutive Supabase failures = DB dead

let lastHeartbeatTs = Date.now();
let startedAt = Date.now();

// Pluggable price-feed staleness probe. Set by `setNetworkHealthSources`.
let getPriceLastTickAt: (() => number) | null = null;
// Pluggable live-state inspector for /audit endpoints. Set by `setAuditProbe`.
let auditProbe: (() => Promise<unknown>) | null = null;
let exiting = false;

/** Register an async function returning live Kalshi state for /audit/lip. */
export function setAuditProbe(probe: () => Promise<unknown>): void {
  auditProbe = probe;
}

/**
 * Register sources for the network-stall watchdog. Pass `getLastTickAt` from
 * PriceFeedAggregator so the watchdog can independently detect outbound stalls.
 */
export function setNetworkHealthSources(opts: { getPriceLastTickAt: () => number }): void {
  getPriceLastTickAt = opts.getPriceLastTickAt;
}

async function triggerExit(reason: string, details: Record<string, unknown>): Promise<void> {
  if (exiting) return;
  exiting = true;
  logger.fatal({ reason, ...details }, '🚨 WATCHDOG: forcing exit so Fly can restart');
  // Fire-and-forget Discord ping; don't await long.
  Promise.race([
    sendDiscord('🔄 Watchdog forcing restart', `Reason: ${reason}. Fly will auto-restart the machine.`, 'error').catch(() => null),
    new Promise(resolve => setTimeout(resolve, 1500)),
  ]).finally(() => setTimeout(() => process.exit(1), 250));
}

/** Strategy code calls this every heartbeat tick to prove it's alive. */
export function touchHeartbeat(): void {
  lastHeartbeatTs = Date.now();
}

/** How stale is the heartbeat right now, in ms? */
export function heartbeatAgeMs(): number {
  return Date.now() - lastHeartbeatTs;
}

/** Start the watchdog: monitor + tcp health server. */
export function startWatchdog(): void {
  startedAt = Date.now();
  lastHeartbeatTs = Date.now();

  // Periodic check: hard-exit if heartbeat stale OR outbound network wedged.
  setInterval(() => {
    const now = Date.now();
    const age = heartbeatAgeMs();
    // Don't kill within the first 120s of boot — strategies + price WS need time.
    const bootGrace = now - startedAt < 120_000;

    if (bootGrace) {
      logger.debug({ ageMs: age }, 'watchdog: boot grace');
      return;
    }

    // (A) Heartbeat wedge
    if (age > STALE_MS) {
      void triggerExit('heartbeat stale', { ageMs: age, threshold: STALE_MS });
      return;
    }

    // (B) Price-feed network stall
    if (getPriceLastTickAt) {
      const lastTickAt = getPriceLastTickAt();
      // If we've never had a tick AND we're past boot grace, that's a hang.
      // If we've had ticks but they stopped > PRICE_STALE_MS ago, also a hang.
      const tickAge = lastTickAt === 0 ? (now - startedAt) : (now - lastTickAt);
      if (tickAge > PRICE_STALE_MS) {
        void triggerExit('price feed stalled (outbound network wedged)', { tickAgeMs: tickAge, threshold: PRICE_STALE_MS });
        return;
      }
    }

    // (C) Supabase write storm
    const sbHealth = getSupabaseHealth();
    if (sbHealth.consecutiveFailures >= SB_FAIL_THRESHOLD) {
      void triggerExit('Supabase write storm', {
        consecutiveFailures: sbHealth.consecutiveFailures,
        lastSuccessAt: sbHealth.lastSuccessAt,
        threshold: SB_FAIL_THRESHOLD,
      });
      return;
    }

    logger.debug({ ageMs: age, sbFails: sbHealth.consecutiveFailures }, 'watchdog: ok');
  }, CHECK_INTERVAL_MS);

  // HTTP health server for Fly health checks. Returns 200 if heartbeat fresh,
  // 503 if stale. Fly will kill the machine after a few failed checks.
  const server = http.createServer(async (req, res) => {
    // /audit/lip — returns live Kalshi order summary (auth-free; used for manual debugging).
    if (req.url === '/audit/lip') {
      if (!auditProbe) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'audit probe not registered' }));
        return;
      }
      try {
        const result = await Promise.race([
          auditProbe(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('audit timeout')), 15_000)),
        ]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    const now = Date.now();
    const age = heartbeatAgeMs();
    const uptime = now - startedAt;
    const sbHealth = getSupabaseHealth();
    const tickAge = getPriceLastTickAt
      ? (getPriceLastTickAt() === 0 ? null : now - getPriceLastTickAt())
      : null;
    const heartbeatOk = age < STALE_MS;
    const priceOk = tickAge === null || tickAge < PRICE_STALE_MS;
    const sbOk = sbHealth.consecutiveFailures < SB_FAIL_THRESHOLD;
    const healthy = heartbeatOk && priceOk && sbOk;
    res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      healthy,
      heartbeatAgeMs: age,
      heartbeatStaleThresholdMs: STALE_MS,
      priceFeed: { tickAgeMs: tickAge, threshold: PRICE_STALE_MS, ok: priceOk },
      supabase: { consecutiveFailures: sbHealth.consecutiveFailures, threshold: SB_FAIL_THRESHOLD, ok: sbOk },
      uptimeMs: uptime,
      ts: new Date(now).toISOString(),
    }));
  });

  server.on('error', (err) => {
    logger.error({ err: err.message }, 'health server error');
  });

  // Bind explicitly to 0.0.0.0 so Fly's fly-proxy can reach it.
  server.listen(HEALTH_PORT, '0.0.0.0', () => {
    logger.info({ port: HEALTH_PORT }, '🛡️  watchdog + health server started');
  });
}
