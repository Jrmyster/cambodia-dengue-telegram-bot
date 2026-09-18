import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createBot } from '../src/bot.js';
import { createApp } from '../src/server.js';
import { callback } from '../src/flow.js';
import { config } from '../src/config.js';

const token = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';
const secret = 'a'.repeat(48);
function update(id, text = '/start', chat = 55, type = 'private') {
  return { update_id: id, message: { message_id: id, date: 1, text,
    entities: text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.length }] : [],
    chat: { id: chat, type }, from: { id: chat, is_bot: false, first_name: 'not retained' } } };
}
async function setup(t, overrides = {}) {
  const store = new Store(':memory:', 'test');
  const bot = createBot(token, store);
  bot.botInfo = { id: 123456, is_bot: true, username: 'triage_test_bot', first_name: 'Test' };
  bot.telegram.callApi = async () => true;
  const app = createApp({ bot, store, mode: 'webhook', webhookSecret: secret, ...overrides });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => { await new Promise(r => server.close(r)); store.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (body, auth = secret) => fetch(`${url}/telegram/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': auth }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { store, bot, post, url };
}

test('webhook secret, JSON validation, health and durable duplicate suppression', async t => {
  const { store, post, url } = await setup(t);
  assert.equal((await post(update(1), 'wrong')).status, 403);
  assert.equal(store.stats().pending, 0);
  assert.equal((await post('{')).status, 400);
  assert.equal((await post({ update_id: '1' })).status, 400);
  assert.equal((await post(JSON.stringify({ update_id: 1, padding: 'a'.repeat(70000) }))).status, 413);
  assert.equal((await post(update(1))).status, 200);
  assert.equal((await post(update(1))).status, 200);
  assert.equal(store.stats().pending, 1);
  assert.equal((await fetch(`${url}/healthz`)).status, 200);
  assert.equal((await fetch(`${url}/readyz`)).status, 200);
});
test('real Telegraf handlers complete a Khmer emergency flow using synthetic updates', async t => {
  const { store, post } = await setup(t);
  await post(update(1));
  let id = 1;
  for (const [action, value] of [['language', 'km'], ['begin', ''], ['fever', 'none'], ['warning', 'yes']]) {
    const s = store.get(55);
    const u = { update_id: ++id, callback_query: { id: `cb${id}`, chat_instance: 'test',
      from: { id: 55, is_bot: false, first_name: 'Test' }, data: callback(s, action, value),
      message: { message_id: id, date: 1, chat: { id: 55, type: 'private' }, text: 'question' } } };
    assert.equal((await post(u)).status, 200);
  }
  assert.equal(store.get(55).result, 'red');
  assert.equal(store.stats().pending, 1); // Urgent message supersedes unsent prompts.
  assert.match(JSON.parse(store.next().payload).text, /🔴/);
});
test('groups, edited messages and channel posts cannot collect clinical data', async t => {
  const { store, post } = await setup(t);
  await post(update(1, '/start', -10, 'group'));
  await post({ update_id: 2, edited_message: update(2).message });
  await post({ update_id: 3, channel_post: update(3).message });
  assert.equal(store.stats().pending, 0);
});
test('failed transaction returns 503 and is retriable', async t => {
  const { store, post } = await setup(t);
  store.db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'simulated'); END");
  assert.equal((await post(update(1))).status, 503);
  store.db.exec('DROP TRIGGER fail_insert');
  assert.equal((await post(update(1))).status, 200);
});
test('not ready responds 503 before accepting work', async t => {
  const { store, post, url } = await setup(t, { isReady: () => false });
  assert.equal((await post(update(1))).status, 503);
  assert.equal((await fetch(`${url}/readyz`)).status, 503);
  assert.equal(store.stats().pending, 0);
});
test('configuration rejects placeholders, insecure webhooks and invalid ranges', () => {
  const env = { TELEGRAM_BOT_TOKEN: token, SESSION_KEY_SECRET: secret };
  assert.equal(config(env).mode, 'polling');
  assert.throws(() => config({ ...env, TELEGRAM_BOT_TOKEN: 'replace_me' }));
  assert.throws(() => config({ ...env, PORT: '-1' }));
  assert.throws(() => config({ ...env, SESSION_TTL_MINUTES: '999' }));
  assert.throws(() => config({ ...env, BOT_MODE: 'webhook', PUBLIC_URL: 'http://bad', WEBHOOK_SECRET: 'b'.repeat(48) }));
  assert.throws(() => config({ ...env, BOT_MODE: 'webhook', PUBLIC_URL: 'https://example.com/path', WEBHOOK_SECRET: 'b'.repeat(48) }));
  assert.throws(() => config({ ...env, BOT_MODE: 'webhook', PUBLIC_URL: 'https://example.com', WEBHOOK_SECRET: secret }));
  assert.equal(config({ ...env, BOT_MODE: 'webhook', PUBLIC_URL: 'https://example.com', WEBHOOK_SECRET: 'b'.repeat(48) }).publicUrl, 'https://example.com');
});
