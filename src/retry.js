import { setTimeout as delay } from 'node:timers/promises';

const NETWORK_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE']);
export function isTransientTelegramError(error) {
  const code = error?.response?.error_code ?? error?.code;
  return code === 429 || (Number.isInteger(code) && code >= 500 && code <= 599) ||
    NETWORK_CODES.has(code) || NETWORK_CODES.has(error?.cause?.code) ||
    (error?.name === 'FetchError' && ['system', 'request-timeout'].includes(error.type));
}

// Telegraf retries getUpdates internally, but getMe/deleteWebhook and other launch
// operations run outside that loop. Retry only transport failures, never bad tokens,
// malformed payloads, storage errors or programmer errors. Polling conflicts get
// a longer cooldown only when explicitly enabled by the polling supervisor.
export async function retryTelegram(operation, { signal, event = 'telegram_retry', log = console.error, sleep = delay, retryConflicts = false } = {}) {
  let attempt = 0;
  for (;;) {
    signal?.throwIfAborted();
    try {
      const result = await operation();
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      const conflict = retryConflicts && (error?.response?.error_code ?? error?.code) === 409;
      if (!isTransientTelegramError(error) && !conflict) throw error;
      const retryAfter = Number(error.response?.parameters?.retry_after);
      const waitMs = Math.max(conflict ? 30000 : 0, Math.min(60000, 1000 * 2 ** Math.min(attempt++, 6)),
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0);
      log(JSON.stringify({ event: conflict ? 'polling_conflict' : event, retry_in_ms: waitMs }));
      await sleep(waitMs, undefined, { signal });
    }
  }
}
