import test from 'node:test';
import assert from 'node:assert/strict';
import { retryTelegram, isTransientTelegramError } from '../src/retry.js';

test('transient polling launch failures retry with bounded exponential backoff', async () => {
  const waits = [], logs = [];
  let calls = 0;
  const result = await retryTelegram(async () => {
    if (++calls <= 9) throw Object.assign(new Error('secret must never appear in logs'), { code: 'ETIMEDOUT' });
    return 'connected';
  }, { sleep: async ms => waits.push(ms), log: line => logs.push(JSON.parse(line)), event: 'polling_retry' });
  assert.equal(result, 'connected'); assert.equal(calls, 10);
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  assert.ok(logs.every(entry => entry.event === 'polling_retry'));
  assert.ok(!JSON.stringify(logs).includes('secret'));
});

test('network reconnect and server failures retry; configuration and application failures propagate', async () => {
  for (const error of [{ code: 'ECONNRESET' }, { cause: { code: 'EAI_AGAIN' } },
    { name: 'FetchError', type: 'request-timeout' }, { response: { error_code: 502 } }]) assert.ok(isTransientTelegramError(error));
  for (const error of [{ response: { error_code: 400 } }, { response: { error_code: 401 } },
    { response: { error_code: 409 } }, { code: 'SQLITE_BUSY' }, new TypeError('bad state')]) {
    await assert.rejects(retryTelegram(async () => { throw error; }, {
      sleep: async () => assert.fail('fatal errors must not retry'),
    }), e => e === error);
  }
});

test('startup retry respects Telegram retry_after and completes on recovery', async () => {
  let calls = 0, waited;
  await retryTelegram(async () => {
    if (++calls === 1) throw { response: { error_code: 429, parameters: { retry_after: 7 } } };
  }, { sleep: async ms => { waited = ms; }, log: () => {} });
  assert.equal(waited, 7000); assert.equal(calls, 2);
});

test('shutdown cancels a pending reconnect and prevents another launch', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(retryTelegram(async () => {
    calls++; throw { code: 'ETIMEDOUT' };
  }, { signal: controller.signal, log: () => { controller.abort(); } }), { name: 'AbortError' });
  assert.equal(calls, 1);
  await assert.rejects(retryTelegram(async () => { calls++; }, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('polling 409 conflicts cool down before reconnect; other modes remain strict', async () => {
  let calls = 0;
  const waits = [], logs = [];
  await retryTelegram(async () => {
    if (++calls <= 3) throw { response: { error_code: 409 } };
  }, { retryConflicts: true, sleep: async ms => waits.push(ms), log: line => logs.push(JSON.parse(line)) });
  assert.equal(calls, 4);
  assert.deepEqual(waits, [30000, 30000, 30000]);
  assert.ok(logs.every(entry => entry.event === 'polling_conflict'));
});
