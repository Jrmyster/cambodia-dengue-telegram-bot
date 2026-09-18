import { resolve } from 'node:path';
export function config(env = process.env) {
  const required = key => {
    const v = env[key];
    if (!v || v.startsWith('replace_')) throw new Error(`Configure ${key}`);
    return v;
  };
  const token = required('TELEGRAM_BOT_TOKEN');
  if (!/^\d+:[\w-]{20,}$/.test(token)) throw new Error('Invalid TELEGRAM_BOT_TOKEN format');
  const sessionSecret = required('SESSION_KEY_SECRET');
  if (sessionSecret.length < 32) throw new Error('SESSION_KEY_SECRET must have at least 32 characters');
  const mode = env.BOT_MODE || 'polling';
  if (!['webhook', 'polling'].includes(mode)) throw new Error('BOT_MODE must be webhook or polling');
  const port = Number(env.PORT || 3000);
  const ttlMinutes = Number(env.SESSION_TTL_MINUTES || 30);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 5 || ttlMinutes > 60) throw new Error('SESSION_TTL_MINUTES must be 5–60');
  let publicUrl, webhookSecret;
  if (mode === 'webhook') {
    const url = new URL(required('PUBLIC_URL'));
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('PUBLIC_URL must be an HTTPS origin');
    publicUrl = url.origin;
    webhookSecret = required('WEBHOOK_SECRET');
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(webhookSecret) || webhookSecret === sessionSecret) throw new Error('Use a separate 32–256 character WEBHOOK_SECRET');
  }
  return { token, sessionSecret, mode, port, ttlMinutes, publicUrl, webhookSecret, databasePath: resolve(env.DATABASE_PATH || './data/bot.sqlite') };
}
