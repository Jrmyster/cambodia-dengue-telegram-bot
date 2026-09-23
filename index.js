import 'dotenv/config';
import { config } from './src/config.js';
import { Store } from './src/store.js';
import { createBot, registerCommands } from './src/bot.js';
import { createApp } from './src/server.js';
import { deliveryWorker } from './src/delivery.js';
import { retryTelegram } from './src/retry.js';

let server, store, bot, worker, pollingDone, ready = false, closing = false, polling = false;
const lifetime = new AbortController();
async function shutdown(code = 0) {
  if (closing) return;
  closing = true; ready = false;
  lifetime.abort();
  const deadline = setTimeout(() => process.exit(code || 1), 15000);
  deadline.unref();
  if (polling) { try { bot.stop('shutdown'); } catch { /* polling has not started */ } }
  worker?.stop();
  if (server) await new Promise(resolve => server.close(resolve));
  await worker?.done;
  await pollingDone;
  store?.close();
  clearTimeout(deadline);
  process.exitCode = code;
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });

try {
  const c = config();
  store = new Store(c.databasePath, c.sessionSecret, c.ttlMinutes * 60000);
  bot = createBot(c.token, store);
  const app = createApp({ bot, store, mode: c.mode, webhookSecret: c.webhookSecret, isReady: () => ready });
  server = await new Promise((resolve, reject) => {
    const s = app.listen(c.port, '0.0.0.0', () => resolve(s));
    s.once('error', reject);
  });
  // Bind health endpoints before contacting Telegram. Readiness remains 503 until
  // initialization succeeds; transient launch failures must not kill the web server.
  const retryOptions = { signal: lifetime.signal };
  bot.botInfo = await retryTelegram(() => bot.telegram.getMe(), retryOptions);
  await retryTelegram(() => registerCommands(bot), retryOptions);
  worker = deliveryWorker(store, bot.telegram, { onFatal: () => { void shutdown(1); } });
  ready = true;
  if (c.mode === 'webhook') {
    await retryTelegram(() => bot.telegram.setWebhook(`${c.publicUrl}/telegram/webhook`, {
      secret_token: c.webhookSecret, allowed_updates: ['message', 'callback_query'],
      max_connections: 10, drop_pending_updates: false,
    }), retryOptions);
  } else {
    polling = true;
    // launch() removes an old webhook; exactly one polling process per token.
    pollingDone = retryTelegram(() => bot.launch({ dropPendingUpdates: false, allowedUpdates: ['message', 'callback_query'] }),
      { ...retryOptions, event: 'polling_retry' }).catch(() => {
      if (closing) return;
      console.error(JSON.stringify({ event: 'polling_failed' }));
      void shutdown(1);
    });
  }
  console.log(JSON.stringify({ event: 'started', mode: c.mode, port: c.port }));
} catch (error) {
  if (!closing) {
    // Never log Telegraf errors/URLs: they may include the bot token or patient data.
    console.error(JSON.stringify({ event: 'startup_failed', reason: /^(Configure |Invalid |Use a separate |SESSION_|PUBLIC_URL|BOT_MODE)/.test(error.message) ? error.message : 'Check configuration, network and persistent disk' }));
    await shutdown(1);
  }
}
