import { Store } from './store.js';

const FILE_ERRORS = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EEXIST', 'EIO']);
const SQLITE_ERRORS = new Set([5, 6, 8, 10, 11, 13, 14, 26]); // Busy/locked, readonly, I/O, corrupt, full, cannot open, not a DB.
export function isStorageFailure(error) {
  return FILE_ERRORS.has(error?.code) || (error?.code === 'ERR_SQLITE_ERROR' &&
    Number.isInteger(error.errcode) && SQLITE_ERRORS.has(error.errcode & 255));
}

// Use one backend for sessions AND reply delivery. Switching sessions alone would
// leave successful /start responses stuck in the inaccessible disk outbox.
export class ResilientStore {
  constructor(path, secret, ttl = 1800000, { now = Date.now, log = console.error } = {}) {
    this.secret = secret; this.ttl = ttl; this.now = now; this.log = log;
    this.generation = 0; this.mode = 'persistent';
    try { this.active = new Store(path, secret, ttl, now); }
    catch (error) {
      if (!isStorageFailure(error)) throw error;
      this.useMemory();
    }
  }
  useMemory() {
    if (this.mode === 'memory') return;
    const memory = new Store(':memory:', this.secret, this.ttl, this.now);
    const previous = this.active;
    this.active = memory; this.mode = 'memory'; this.generation++;
    try { previous?.close(); } catch { /* A failed disk handle must not block recovery. */ }
    this.log(JSON.stringify({ event: 'storage_memory_fallback', persistence: false }));
  }
  call(method, args = [], generation) {
    if (generation !== undefined && generation !== this.generation) return;
    try { return this.active[method](...args); }
    catch (error) {
      if (this.mode === 'memory' || !isStorageFailure(error)) throw error;
      this.useMemory();
      if (generation !== undefined) return; // Never apply an old outbox ID to the new DB.
      if (method === 'accept' && /:warning:yes$/.test(args[2]?.data || '')) {
        args = [args[0], args[1], { command: 'emergency' }];
      }
      return this.active[method](...args);
    }
  }
  accept(...args) { return this.call('accept', args); }
  get(...args) { return this.call('get', args); }
  next() {
    const row = this.call('next');
    return row ? { ...row, generation: this.generation } : undefined;
  }
  delivered(id, generation) { return this.call('delivered', [id], generation); }
  postpone(key, delay, generation) { return this.call('postpone', [key, delay], generation); }
  retry(id, delay, generation) { return this.call('retry', [id, delay], generation); }
  forget(key, generation) { return this.call('forget', [key], generation); }
  prune() { return this.call('prune'); }
  stats() { return { ...this.call('stats'), storage: this.mode }; }
  close() { this.active.close(); }
}
