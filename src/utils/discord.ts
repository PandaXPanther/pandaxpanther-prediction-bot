import axios from 'axios';
import { getConfig } from './config.js';
import { logger } from './logger.js';

export type AlertLevel = 'info' | 'success' | 'warn' | 'error';

const COLORS: Record<AlertLevel, number> = {
  info: 0x3498db,
  success: 0x2ecc71,
  warn: 0xf39c12,
  error: 0xe74c3c,
};

export interface DiscordOptions {
  /** Whether to @mention the configured DISCORD_NOTIFY_USER_ID. Default: true for success/error, false for info. */
  mention?: boolean;
  fields?: { name: string; value: string; inline?: boolean }[];
}

export async function sendDiscord(
  title: string,
  message: string,
  level: AlertLevel = 'info',
  fieldsOrOptions?: { name: string; value: string; inline?: boolean }[] | DiscordOptions
): Promise<void> {
  const config = getConfig();
  if (!config.DISCORD_WEBHOOK_URL) return;

  // Backward-compat: old signature passes fields as 4th arg
  let fields: { name: string; value: string; inline?: boolean }[] | undefined;
  let mention: boolean;
  if (Array.isArray(fieldsOrOptions)) {
    fields = fieldsOrOptions;
    mention = level === 'success' || level === 'error';  // default for arrays
  } else {
    fields = fieldsOrOptions?.fields;
    mention = fieldsOrOptions?.mention ?? (level === 'success' || level === 'error');
  }

  const userId = config.DISCORD_NOTIFY_USER_ID;
  const content = mention && userId ? `<@${userId}>` : undefined;

  // v1 LOW-10: lightweight retry on 429/5xx. Single-shot failures used to lose the
  // alert entirely; this covers ~2s of transient flakiness. We don't retry on 4xx
  // (other than 429) since those are genuine payload issues.
  const payload = {
    content,
    allowed_mentions: userId ? { users: [userId] } : undefined,
    embeds: [
      {
        title,
        description: message,
        color: COLORS[level],
        fields: fields ?? [],
        timestamp: new Date().toISOString(),
        footer: { text: `PandaXPanther Prediction Bot · ${config.TRADING_MODE.toUpperCase()}` },
      },
    ],
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await axios.post(config.DISCORD_WEBHOOK_URL, payload, { timeout: 5000 });
      return;
    } catch (err: any) {
      const status = err?.response?.status;
      const retryable = !status || status === 429 || status >= 500;
      if (!retryable || attempt === 3) {
        logger.warn({ err: err?.message ?? String(err), status, attempt }, 'Failed to send Discord alert');
        return;
      }
      await new Promise((r) => setTimeout(r, 200 * 2 ** (attempt - 1))); // 200ms, 400ms
    }
  }
}
