import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createBot } from '../src/bot.js';
import { createApp } from '../src/server.js';
import { callback } from '../src/flow.js';
import { config } from '../src/config.js';
import { deliveryWorker } from '../src/delivery.js';
import { locales } from '../locales.js';

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
  const acknowledgements = [];
  bot.context.answerCbQuery = async function (text) {
    await new Promise(resolve => setImmediate(resolve));
    acknowledgements.push({ id: this.callbackQuery.id, text });
    return true;
  };
  const app = createApp({ bot, store, mode: 'webhook', webhookSecret: secret, ...overrides });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => { await new Promise(r => server.close(r)); store.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (body, auth = secret) => fetch(`${url}/telegram/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': auth }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { store, bot, post, url, acknowledgements };
}

function buttonUpdate(id, data, chat = 55) {
  return { update_id: id, callback_query: { id: `cb${id}`, chat_instance: 'test', data,
    from: { id: chat, is_bot: false, first_name: 'Test' },
    message: { message_id: id, date: 1, chat: { id: chat, type: 'private' }, text: 'question' } } };
}

async function deliver(store) {
  const messages = [];
  let worker;
  worker = deliveryWorker(store, { sendMessage: async (chat, text, extra) => { messages.push({ chat, text, extra }); } },
    { sleep: async () => {
      if (!store.stats().pending) worker.stop();
      else store.db.prepare('UPDATE outbox SET due=0').run();
    }, onFatal: () => assert.fail('delivery must succeed') });
  await worker.done;
  return messages;
}

test('/start, both language keyboards and freeform text produce delivered replies', async t => {
  const { store, post, acknowledgements } = await setup(t);
  let id = 400;
  for (const lang of ['en', 'km']) {
    assert.equal((await post(update(++id))).status, 200);
    const [menu] = await deliver(store);
    const buttons = menu.extra.reply_markup.inline_keyboard.flat();
    const data = buttons.find(b => b.callback_data.endsWith(`:language:${lang}`)).callback_data;
    assert.equal((await post(buttonUpdate(++id, data))).status, 200);
    assert.equal(acknowledgements.at(-1).id, `cb${id}`); // HTTP waits for acknowledgement.
    assert.match((await deliver(store))[0].text, new RegExp(locales[lang].intro.slice(0, 10)));
    const state = store.get(55);
    for (const text of ['Hi', 'Hello', 'anything else', '/unknown']) {
      assert.equal((await post(update(++id, text))).status, 200);
      const replies = await deliver(store);
      assert.equal(replies[0].text, locales[lang].fallback);
      assert.ok(replies[1].extra.reply_markup.inline_keyboard.length > 0);
      assert.deepEqual(store.get(55), state);
    }
    await post(update(++id, ' HELP '));
    assert.ok((await deliver(store))[0].text.startsWith(locales[lang].help));
  }
});

test('greetings before onboarding and after expiry return a usable language menu', async t => {
  const { store, post } = await setup(t);
  for (const [id, text] of [[600, 'Hi'], [601, 'Hello']]) {
    store.db.prepare('UPDATE sessions SET expires=0').run();
    assert.equal((await post(update(id, text))).status, 200);
    const [message] = await deliver(store);
    assert.match(message.text, /Choose your language/);
    assert.equal(message.extra.reply_markup.inline_keyboard.length, 2);
    assert.equal(store.get(55).stage, 'language');
  }
});

test('expired language callbacks recover in one tap; old clinical callbacks cannot answer', async t => {
  const { store, post, acknowledgements } = await setup(t);
  await post(update(700));
  const oldLanguage = callback(store.get(55), 'language', 'km');
  store.db.prepare('UPDATE sessions SET expires=0').run();
  await post(buttonUpdate(701, oldLanguage));
  assert.equal(store.get(55).lang, 'km');
  const oldClinical = callback(store.get(55), 'begin');
  store.db.prepare('UPDATE sessions SET expires=0').run();
  await post(buttonUpdate(702, oldClinical));
  assert.equal(store.get(55).stage, 'language');
  await post(buttonUpdate(703, 'lang_en'));
  assert.equal(store.get(55).lang, 'en');
  assert.equal(acknowledgements.length, 3);
});

test('callback acknowledgements cover duplicates, invalid data and failed storage', async t => {
  const { store, post, acknowledgements, bot } = await setup(t);
  const u = buttonUpdate(800, 'lang_kh');
  await post(u); await post(u);
  await post(buttonUpdate(801, 'x'.repeat(65)));
  assert.equal(acknowledgements.length, 3);
  store.db.exec("CREATE TRIGGER fail_callback BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'simulated'); END");
  assert.equal((await post(buttonUpdate(802, 'bad'))).status, 503);
  assert.equal(acknowledgements.length, 4);
  store.db.exec('DROP TRIGGER fail_callback');
  bot.context.answerCbQuery = async () => { throw new Error('expired callback'); };
  assert.equal((await post(buttonUpdate(802, 'bad'))).status, 200);
  assert.ok(store.stats().pending > 0);
});

test('an unresponsive acknowledgement cannot stall the webhook or lose its reply', async t => {
  const { store, post, bot } = await setup(t);
  bot.context.answerCbQuery = () => new Promise(() => {});
  assert.equal((await post(buttonUpdate(900, 'lang_en'))).status, 200);
  assert.equal(store.get(55).lang, 'en');
  assert.equal(store.stats().pending, 1);
});

test('health aliases are alive in both modes even while readiness is unavailable', async t => {
  for (const mode of ['polling', 'webhook']) {
    const { url } = await setup(t, { mode, isReady: () => false });
    for (const path of ['/', '/health', '/healthz']) {
      const response = await fetch(url + path);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: 'alive' });
    }
    assert.equal((await fetch(`${url}/readyz`)).status, 503);
  }
});

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
  assert.equal(store.db.prepare("SELECT count FROM analytics_events WHERE event_type='RED_FLAG_ESCALATION'").get().count, 1);
});

test('real Telegram location handler requires opt-in and strips identity and exact coordinates', async t => {
  const { store, post } = await setup(t);
  let id = 100;
  const tap = async (action, value) => post({ update_id: ++id, callback_query: { id: `location${id}`, chat_instance: 'test',
    from: { id: 55, is_bot: false, first_name: 'PRIVATE_FIRST_NAME' }, data: callback(store.get(55), action, value),
    message: { message_id: id, date: 1, chat: { id: 55, type: 'private' }, text: 'question' } } });
  const pin = () => ({ update_id: ++id, message: { message_id: id, date: 1,
    chat: { id: 55, type: 'private', username: 'PRIVATE_USERNAME' },
    from: { id: 55, is_bot: false, first_name: 'PRIVATE_FIRST_NAME', username: 'PRIVATE_USERNAME' },
    location: { latitude: 11.556417, longitude: 104.928263, horizontal_accuracy: 7 },
    contact: { phone_number: 'PRIVATE_PHONE', first_name: 'PRIVATE_CONTACT' } } });
  assert.equal((await post(pin())).status, 200);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM location_reports').get().n, 0);
  await tap('language', 'km'); await tap('province', 'pp');
  const accepted = pin();
  assert.equal((await post(accepted)).status, 200); await post(accepted);
  const entry = store.db.prepare('SELECT * FROM location_reports').get();
  assert.equal(entry.latitude, 11.55); assert.equal(entry.longitude, 104.95); assert.equal(entry.report_count, 1);
  assert.equal(store.get(55).lang, 'km');
  assert.equal(store.get(55).locationRequest, undefined);
  const persisted = JSON.stringify([
    ...store.db.prepare('SELECT * FROM location_reports').all(),
    ...store.db.prepare('SELECT * FROM analytics_events').all(),
    ...store.db.prepare('SELECT * FROM analytics_dedup').all(),
    ...store.db.prepare('SELECT state FROM sessions').all(),
    ...store.db.prepare('SELECT payload FROM outbox').all(),
  ]);
  for (const forbidden of ['PRIVATE_USERNAME', 'PRIVATE_FIRST_NAME', 'PRIVATE_PHONE', 'PRIVATE_CONTACT', '11.556417', '104.928263', 'horizontal_accuracy']) assert.ok(!persisted.includes(forbidden));
});

test('location handling rejects live/forwarded pins and ignores group or edited locations', async t => {
  const { store, post } = await setup(t);
  await post(update(200, '/location'));
  let id = 200;
  for (const [action, value] of [['language', 'en'], ['province', 'sr']]) {
    await post({ update_id: ++id, callback_query: { id: `cb${id}`, chat_instance: 'test',
      from: { id: 55, is_bot: false, first_name: 'Test' }, data: callback(store.get(55), action, value),
      message: { message_id: id, date: 1, chat: { id: 55, type: 'private' }, text: 'question' } } });
  }
  const base = { message_id: 999, date: 1, chat: { id: 55, type: 'private' }, from: { id: 55, is_bot: false, first_name: 'Test' }, location: { latitude: 13.36, longitude: 103.85 } };
  for (const message of [
    { ...base, location: { ...base.location, live_period: 900 } },
    { ...base, forward_origin: { type: 'user', sender_user: { id: 999, first_name: 'Other' }, date: 1 } },
    { ...base, location: { latitude: '13.36', longitude: 103.85 } },
    { ...base, location: null },
    { ...base, chat: { id: -100, type: 'group' } },
    { ...base, from: { id: 999, is_bot: false, first_name: 'Other' } },
  ]) assert.equal((await post({ update_id: ++id, message })).status, 200);
  await post({ update_id: ++id, edited_message: base });
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM location_reports').get().n, 0);
  assert.equal(store.get(55).locationRequest.step, 'pin');
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
