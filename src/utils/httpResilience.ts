/**
 * HTTP resilience layer — patches global axios with retry + jitter on transient errors.
 *
 * Why this exists: Fly DFW has periodic outbound network stalls. A single 8s timeout
 * looks like total failure even though a retry 200ms later usually works. With 27+
 * axios call sites, wrapping each individually is error-prone — instead we patch
 * `axios.defaults` and add a response interceptor that retries idempotent calls
 * on connect-level / 5xx / timeout errors.
 *
 * Retry policy:
 *   - Retries: 2 (total 3 attempts)
 *   - Backoff: 250ms * 2^n + jitter(0-150ms)
 *   - Retryable errors: ECONNABORTED, ETIMEDOUT, ECONNRESET, ENETUNREACH, EAI_AGAIN,
 *     timeout, HTTP 502/503/504, and any error without a response (network-level)
 *   - GET / HEAD always retried. POST/PUT/DELETE retried only on connect-level failure
 *     (no response received — safe because server never saw the request).
 */

import axios, { AxiosInstance } from 'axios';
import { logger } from './logger.js';

const RETRYABLE_CODES = new Set([
  'ECONNABORTED',
  'ETIMEDOUT',
  'ECONNRESET',
  'ENETUNREACH',
  'EAI_AGAIN',
  'ENOTFOUND',  // DNS hiccup
  'EPIPE',
  'ERR_NETWORK',
]);

const RETRYABLE_STATUS = new Set([408, 425, 429, 502, 503, 504]);

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 250;
const MAX_JITTER_MS = 150;

function isIdempotent(method: string | undefined): boolean {
  const m = (method ?? 'get').toLowerCase();
  return m === 'get' || m === 'head' || m === 'options';
}

function shouldRetry(err: any, method: string | undefined): boolean {
  // No response = connect/transport failure. Safe to retry any method.
  if (!err.response) {
    if (err.code && RETRYABLE_CODES.has(err.code)) return true;
    // axios timeout
    if (err.message && /timeout/i.test(err.message)) return true;
    // generic network error
    if (err.message && /network|socket hang up/i.test(err.message)) return true;
    return false;
  }
  // Got a response — only retry idempotent methods on transient 5xx-ish codes.
  if (!isIdempotent(method)) return false;
  return RETRYABLE_STATUS.has(err.response.status);
}

function backoffDelay(attempt: number): number {
  return BASE_DELAY_MS * Math.pow(2, attempt) + Math.floor(Math.random() * MAX_JITTER_MS);
}

/**
 * Attach the retry interceptor to a specific axios instance.
 * Use this for instances created via `axios.create()` (e.g. Supabase client).
 */
export function attachRetryInterceptor(instance: AxiosInstance, label = 'axios'): void {
  instance.interceptors.response.use(
    (resp) => resp,
    async (err: any) => {
      const cfg = err.config;
      if (!cfg) throw err;

      // @ts-ignore augment config with retry counter
      cfg.__retryCount = cfg.__retryCount ?? 0;

      if (!shouldRetry(err, cfg.method) || cfg.__retryCount >= MAX_RETRIES) {
        throw err;
      }

      cfg.__retryCount += 1;
      const delay = backoffDelay(cfg.__retryCount - 1);

      logger.debug({
        instance: label,
        url: typeof cfg.url === 'string' ? cfg.url.slice(0, 80) : '?',
        method: cfg.method,
        attempt: cfg.__retryCount,
        delayMs: delay,
        err: err.code ?? err.response?.status ?? err.message,
      }, 'http retry');

      await new Promise(resolve => setTimeout(resolve, delay));
      return instance.request(cfg);
    },
  );
}

/**
 * Install global axios retry interceptor on the DEFAULT axios export.
 * Call once at boot from index.ts. Safe to call multiple times (idempotent).
 *
 * NOTE: This only patches `axios.get/post/...` direct calls. Instances created
 * via `axios.create()` have their own interceptor chain — call
 * `attachRetryInterceptor(instance)` on those separately.
 */
let installed = false;
export function installHttpResilience(): void {
  if (installed) return;
  installed = true;

  // Set a sensible default timeout for any axios call that didn't specify one.
  if (!axios.defaults.timeout || axios.defaults.timeout === 0) {
    axios.defaults.timeout = 10_000;
  }

  attachRetryInterceptor(axios as unknown as AxiosInstance, 'default');

  logger.info({ maxRetries: MAX_RETRIES, baseDelayMs: BASE_DELAY_MS }, '🔁 HTTP resilience installed (global axios retry)');
}
