import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installProcessErrorHandlers } from '../src/process-errors.js';

test('global handlers isolate recoverable rejections and restart unknown exceptions without logging secrets', () => {
  const target = new EventEmitter(), logs = [];
  let fallback = 0, fatal = 0;
  const remove = installProcessErrorHandlers({ target, log: line => logs.push(line),
    onStorageFailure: () => fallback++, onFatal: () => fatal++ });
  target.emit('unhandledRejection', { code: 'ETIMEDOUT', message: 'PRIVATE_TOKEN' });
  assert.equal(fatal, 0);
  target.emit('unhandledRejection', { code: 'ERR_SQLITE_ERROR', errcode: 8 });
  assert.equal(fallback, 1); assert.equal(fatal, 0);
  target.emit('uncaughtException', new TypeError('PRIVATE_TOKEN'));
  target.emit('unhandledRejection', new Error('PRIVATE_TOKEN'));
  assert.equal(fatal, 2); assert.ok(!logs.join().includes('PRIVATE_TOKEN'));
  remove();
  assert.equal(target.listenerCount('uncaughtException'), 0);
  assert.equal(target.listenerCount('unhandledRejection'), 0);
});
