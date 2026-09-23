import { Telegraf } from 'telegraf';
import { common, locales } from '../locales.js';

export function createBot(token, store) {
  const bot = new Telegraf(token, { handlerTimeout: 10000, telegram: { webhookReply: false } });
  bot.use(async (ctx, next) => {
    if (!ctx.chat || ctx.chat.type !== 'private' || !ctx.from || ctx.from.id !== ctx.chat.id) return;
    if (!Number.isSafeInteger(ctx.update.update_id) || !Number.isSafeInteger(ctx.chat.id)) return;
    await next();
  });
  const accept = (ctx, event) => store.accept(ctx.update.update_id, ctx.chat.id, event);
  for (const command of ['start', 'resume', 'prevention', 'emergency', 'cancel', 'help', 'location', 'referral']) {
    bot.command(command, ctx => { accept(ctx, { command }); });
  }
  bot.on('callback_query', async ctx => {
    const data = ctx.callbackQuery.data;
    let result;
    try {
      result = accept(ctx, typeof data === 'string' && Buffer.byteLength(data) <= 64
        ? { data } : { command: 'unknown' });
    } finally {
      // Acknowledge every tap, including malformed/expired buttons and storage failures.
      // Bound this best-effort API call below the middleware timeout; the durable reply
      // queue is independent of the spinner and must survive an acknowledgement failure.
      const lang = ctx.from.language_code === 'km' ? 'km' : 'en';
      let timer;
      try {
        await Promise.race([
          ctx.answerCbQuery(result === 'limited' ? locales[lang].busy : undefined),
          new Promise(resolve => { timer = setTimeout(resolve, 2000); }),
        ]);
      } catch { /* Telegram may reject old queries or be temporarily unreachable. */ }
      finally { clearTimeout(timer); }
    }
  });
  bot.on('location', ctx => {
    const pin = ctx.message.location ?? {};
    // Allowlist only: do not send names, Telegram IDs, forwarded sender objects,
    // live tracking metadata, captions, phone numbers or full updates to analytics.
    accept(ctx, { command: 'location_pin', location: {
      latitude: pin.latitude, longitude: pin.longitude,
      live: pin.live_period !== undefined || pin.heading !== undefined || pin.proximity_alert_radius !== undefined,
      forwarded: Boolean(ctx.message.forward_origin || ctx.message.forward_from || ctx.message.forward_from_chat || ctx.message.forward_sender_name),
    } });
  });
  bot.on('text', ctx => {
    // Never persist or attempt clinical interpretation of the user's freeform text.
    const command = ctx.message.text.trim().toLowerCase() === 'help' ? 'help' : 'text';
    accept(ctx, { command });
  });
  bot.on('message', ctx => { accept(ctx, { command: 'unknown' }); });
  // Propagate storage failures so Telegram retries webhook delivery.
  bot.catch(error => { throw error; });
  return bot;
}

export async function registerCommands(bot) {
  const names = ['start', 'resume', 'prevention', 'emergency', 'cancel', 'help', 'location', 'referral'];
  for (const language of ['', 'en', 'km']) {
    const t = locales[language || 'en'];
    await bot.telegram.setMyCommands(names.map((command, i) => ({ command, description: t.commandDescriptions[i] })),
      { scope: { type: 'all_private_chats' }, ...(language ? { language_code: language } : {}) });
  }
  await bot.telegram.setMyDescription(`${common.chooseLanguage}\nDengue referral support / ជំនួយណែនាំសម្រាប់ជំងឺគ្រុនឈាម\n${common.urgent}`);
}
