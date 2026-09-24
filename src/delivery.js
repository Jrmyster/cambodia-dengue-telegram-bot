import { setTimeout as delay } from 'node:timers/promises';

export function deliveryWorker(store, telegram, { onFatal, log = console.error, sleep = delay } = {}) {
  let stopping = false;
  const run = async () => {
    let lastPrune = 0;
    while (!stopping) {
      try {
        if (Date.now() - lastPrune > 60000) {
          const expired = store.prune();
          if (expired) log(JSON.stringify({ event: 'expired_undelivered_messages', count: expired }));
          lastPrune = Date.now();
        }
        const row = store.next();
        if (!row) { await sleep(200); continue; }
        const { text, extra } = JSON.parse(row.payload);
        try {
          await telegram.sendMessage(row.chat, text, extra);
          store.delivered(row.id, row.generation);
          store.postpone(row.key, 1100, row.generation);
          await sleep(60); // Under Telegram's approximate global message ceiling.
        } catch (error) {
          const code = error.response?.error_code;
          if (code === 403) { store.forget(row.key, row.generation); continue; }
          if (code === 400 || code === 401) throw new Error('Permanent delivery configuration failure');
          const backoff = code === 429
            ? Math.max(1000, Number(error.response?.parameters?.retry_after || 1) * 1000)
            : Math.min(60000, 1000 * 2 ** Math.min(row.attempts, 6));
          store.retry(row.id, backoff, row.generation);
          log(JSON.stringify({ event: 'delivery_retry', code: Number.isInteger(code) ? code : 'network' }));
          if (code === 429) await sleep(backoff); // Applies to the whole bot, not just one chat.
        }
      } catch {
        stopping = true;
        log(JSON.stringify({ event: 'delivery_worker_failed' }));
        onFatal?.();
      }
    }
  };
  const done = run();
  return { done, stop: () => { stopping = true; } };
}
