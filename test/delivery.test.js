import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { deliveryWorker } from '../src/delivery.js';

test('successful delivery removes the queued chat identifier and payload', async t => {
  const store = new Store(':memory:', 'test'); t.after(() => store.close());
  store.accept(1, 99, { command: 'start' });
  let sent = 0, worker;
  worker = deliveryWorker(store, { sendMessage: async (chat, text) => {
    assert.equal(chat, '99'); assert.match(text, /119/); sent++;
  } }, { sleep: async () => { worker.stop(); } });
  await worker.done;
  assert.equal(sent, 1); assert.equal(store.stats().pending, 0);
});
test('network errors retain the reply with backoff; restart can retry', async t => {
  const store = new Store(':memory:', 'test'); t.after(() => store.close());
  store.accept(1, 99, { command: 'start' });
  let worker;
  worker = deliveryWorker(store, { sendMessage: async () => { throw new Error('simulated network'); } },
    { sleep: async () => { worker.stop(); }, log: () => {} });
  await worker.done;
  assert.equal(store.stats().pending, 1);
  assert.equal(store.next(), undefined);
  assert.equal(store.db.prepare('SELECT attempts FROM outbox').get().attempts, 1);
});
test('Telegram 429 retry_after applies to the worker', async t => {
  const store = new Store(':memory:', 'test'); t.after(() => store.close());
  store.accept(1, 99, { command: 'start' });
  let worker, waited;
  worker = deliveryWorker(store, { sendMessage: async () => { throw { response: { error_code: 429, parameters: { retry_after: 7 } } }; } },
    { sleep: async ms => { waited = ms; worker.stop(); }, log: () => {} });
  await worker.done;
  assert.equal(waited, 7000); assert.equal(store.stats().pending, 1);
});
test('blocked users are forgotten; invalid API payload fails visibly and retains work', async t => {
  for (const code of [403, 400]) {
    const store = new Store(':memory:', 'test');
    let worker, fatal = false;
    store.accept(1, 99, { command: 'start' });
    worker = deliveryWorker(store, { sendMessage: async () => { throw { response: { error_code: code } }; } },
      { sleep: async () => { worker.stop(); }, log: () => {}, onFatal: () => { fatal = true; } });
    await worker.done;
    assert.equal(fatal, code === 400);
    assert.equal(store.stats().pending, code === 400 ? 1 : 0);
    if (code === 403) assert.equal(store.get(99), null);
    store.close();
  }
});
