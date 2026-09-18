import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { callback } from '../src/flow.js';

test('updates are idempotent, double taps do not advance, users are isolated', t => {
  const db = new Store(':memory:', 'test'); t.after(() => db.close());
  db.accept(1, 10, { command: 'start' });
  const s = db.get(10), pending = db.stats().pending;
  assert.equal(db.accept(1, 10, { command: 'start' }), 'duplicate');
  assert.equal(db.stats().pending, pending);
  db.accept(2, 20, { command: 'start' });
  db.accept(3, 10, { data: callback(s, 'language', 'km') });
  db.accept(4, 10, { data: callback(s, 'language', 'km') });
  assert.equal(db.get(10).rev, 1);
  assert.equal(db.get(20).lang, null);
});
test('state and undelivered replies survive restart; cancel clears both', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dengue-test-'));
  const path = join(dir, 'state.sqlite');
  let db = new Store(path, 'test');
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.accept(1, 10, { command: 'start' });
  const nonce = db.get(10).nonce;
  db.close(); db = new Store(path, 'test');
  assert.equal(db.get(10).nonce, nonce);
  assert.equal(db.stats().pending, 1);
  db.accept(2, 10, { command: 'cancel' });
  assert.equal(db.get(10), null);
  assert.equal(db.stats().pending, 1); // Only the deletion confirmation remains.
  assert.match(JSON.parse(db.next().payload).text, /cleared/);
});
test('transaction rollback retains the update for a webhook retry', t => {
  const db = new Store(':memory:', 'test'); t.after(() => db.close());
  db.db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'disk simulation'); END");
  assert.throws(() => db.accept(1, 10, { command: 'start' }));
  assert.equal(db.get(10), null);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM updates').get().n, 0);
  db.db.exec('DROP TRIGGER fail_insert');
  assert.equal(db.accept(1, 10, { command: 'start' }), 'accepted');
});
test('TTL expires answers and queued content; late buttons start safely', t => {
  let now = 1000;
  const db = new Store(':memory:', 'test', 60000, () => now); t.after(() => db.close());
  db.accept(1, 10, { command: 'start' });
  const old = callback(db.get(10), 'language', 'en');
  now += 60001;
  assert.equal(db.get(10), null);
  assert.equal(db.prune(), 1);
  db.accept(2, 10, { data: old });
  assert.equal(db.get(10).stage, 'language');
  assert.equal(db.get(10).lang, null);
});
test('a delayed recipient does not block another recipient', t => {
  const db = new Store(':memory:', 'test'); t.after(() => db.close());
  db.accept(1, 10, { command: 'start' });
  db.accept(2, 20, { command: 'start' });
  const first = db.next(); db.retry(first.id, 60000);
  assert.equal(db.next().chat, '20');
});
test('burst cap never suppresses emergency or cancel commands', t => {
  const db = new Store(':memory:', 'test'); t.after(() => db.close());
  for (let i = 0; i < 40; i++) db.accept(i, 10, { command: 'help' });
  assert.equal(db.accept(40, 10, { command: 'help' }), 'limited');
  assert.equal(db.accept(41, 10, { command: 'emergency' }), 'accepted');
  assert.equal(db.accept(42, 10, { command: 'cancel' }), 'accepted');
});
