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

export async function sendDiscord(
  title: string,
  message: string,
  level: AlertLevel = 'info',
  fields?: { name: string; value: string; inline?: boolean }[]
): Promise<void> {
  const config = getConfig();
  if (!config.DISCORD_WEBHOOK_URL) return;

  try {
    await axios.post(config.DISCORD_WEBHOOK_URL, {
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
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to send Discord alert');
  }
}
