import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ResilientStore, isStorageFailure } from '../src/resilient-store.js';
import { deliveryWorker } from '../src/delivery.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dengue-resilient-'));
  const logs = [];
  const store = new ResilientStore(join(dir, 'bot.sqlite'), 'test', 60000, { log: line => logs.push(JSON.parse(line)) });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, logs };
}

test('invalid directory path falls back at startup without exposing paths or secrets', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dengue-invalid-path-'));
  const file = join(dir, 'not-a-directory'); writeFileSync(file, '');
  const logs = [];
  const store = new ResilientStore(join(file, 'bot.sqlite'), 'SECRET', undefined, { log: line => logs.push(line) });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(store.mode, 'memory');
  assert.equal(store.accept(1, 55, { command: 'start' }), 'accepted');
  assert.equal(store.get(55).stage, 'language');
  assert.equal(store.stats().pending, 1);
  assert.ok(!logs.join().includes('SECRET')); assert.ok(!logs.join().includes(dir));
});

test('an actual SQLite write lock switches sessions and outbox together', t => {
  const { dir, store, logs } = fixture(t);
  const lock = new DatabaseSync(join(dir, 'bot.sqlite'));
  try {
    lock.exec('BEGIN IMMEDIATE');
    assert.equal(store.accept(1, 55, { command: 'start' }), 'accepted');
    assert.equal(store.mode, 'memory');
    assert.equal(store.stats().pending, 1);
    assert.equal(store.accept(1, 55, { command: 'start' }), 'duplicate');
    assert.equal(logs.length, 1);
  } finally { lock.exec('ROLLBACK'); lock.close(); }
  // Do not bounce back to old persistent sessions midway through a conversation.
  store.accept(2, 66, { command: 'start' });
  assert.equal(store.mode, 'memory');
  assert.notEqual(store.get(55).nonce, store.get(66).nonce);
});

test('read-only failures during queue access recover, but constraints/programming failures do not switch backends', t => {
  const { store } = fixture(t);
  store.active.db.exec("CREATE TRIGGER fail BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'invalid payload'); END");
  assert.throws(() => store.accept(1, 55, { command: 'start' }));
  assert.equal(store.mode, 'persistent');
  store.active.db.exec('DROP TRIGGER fail');
  store.active.db.exec('PRAGMA query_only=ON');
  store.prune();
  assert.equal(store.mode, 'memory');
  assert.equal(isStorageFailure(new TypeError('wrong code')), false);
});

test('an in-flight disk reply cannot delete or delay new memory replies with the same row ID', async t => {
  const { store } = fixture(t);
  store.accept(1, 55, { command: 'start' });
  let worker;
  worker = deliveryWorker(store, { sendMessage: async () => {
    store.active.db.exec('PRAGMA query_only=ON');
    store.accept(2, 55, { command: 'start' });
  } }, { sleep: async () => worker.stop(), onFatal: () => assert.fail('worker must survive') });
  await worker.done;
  assert.equal(store.mode, 'memory');
  assert.equal(store.next().id, 1);
  assert.equal(store.next().attempts, 0);
  assert.equal(store.stats().pending, 1);
});

test('positive warning at the storage failure boundary still gives immediate emergency guidance', t => {
  const { store } = fixture(t);
  store.active.db.exec('PRAGMA query_only=ON');
  store.accept(1, 55, { data: '123456abcdef:3:warning:yes' });
  assert.match(JSON.parse(store.next().payload).text, /119/);
  assert.equal(store.get(55).pending, 'emergency');
});
