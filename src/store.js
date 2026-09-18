import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { transition } from './flow.js';

const DAY = 86400000;
export class Store {
  constructor(path, secret, ttl = 1800000, now = Date.now) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path); this.secret = secret; this.ttl = ttl; this.now = now;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS sessions (key TEXT PRIMARY KEY, state TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS updates (id INTEGER PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, chat TEXT NOT NULL,
        payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS outbox_due ON outbox(due);
      CREATE INDEX IF NOT EXISTS outbox_key ON outbox(key,id);
      CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);`);
  }
  key(chatId) { return createHmac('sha256', this.secret).update(String(chatId)).digest('hex'); }
  get(chatId) {
    const r = this.db.prepare('SELECT state FROM sessions WHERE key=? AND expires>?').get(this.key(chatId), this.now());
    return r ? JSON.parse(r.state) : null;
  }
  accept(updateId, chatId, event) {
    const now = this.now(), key = this.key(chatId);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare('SELECT 1 FROM updates WHERE id=?').get(updateId)) { this.db.exec('COMMIT'); return 'duplicate'; }
      this.db.prepare('INSERT INTO updates VALUES (?,?)').run(updateId, now + 2 * DAY);
      const limit = this.db.prepare('SELECT * FROM limits WHERE key=? AND expires>?').get(key, now);
      // Emergency/cancel always bypass the per-chat burst cap. Telegram remains the outer rate limiter.
      const privileged = event.command === 'emergency' || event.command === 'cancel' || /:(emergency|area|cancel):/.test(event.data || '') || /:warning:yes$/.test(event.data || '');
      if (limit?.count >= 40 && !privileged) { this.db.exec('COMMIT'); return 'limited'; }
      this.db.prepare('INSERT OR REPLACE INTO limits VALUES (?,?,?)').run(key, (limit?.count || 0) + 1, limit?.expires || now + 60000);
      const result = transition(this.get(chatId), event);
      if (result.clear || result.state?.result === 'red') this.db.prepare('DELETE FROM outbox WHERE key=?').run(key);
      if (result.state) {
        this.db.prepare('INSERT OR REPLACE INTO sessions VALUES (?,?,?)').run(key, JSON.stringify(result.state), now + this.ttl);
      } else this.db.prepare('DELETE FROM sessions WHERE key=?').run(key);
      for (const m of result.messages) {
        // Match actual configured privacy retention in onboarding copy.
        m.text = m.text.replace('30 minutes', `${this.ttl / 60000} minutes`).replace('៣០ នាទី', `${String(this.ttl / 60000).replace(/\d/g, d => '០១២៣៤៥៦៧៨៩'[d])} នាទី`);
        this.db.prepare('INSERT INTO outbox (key,chat,payload,due,created) VALUES (?,?,?,?,?)').run(key, String(chatId), JSON.stringify(m), now, now);
      }
      this.db.exec('COMMIT'); return 'accepted';
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  next() {
    // Preserve order within each chat; a blocked chat cannot block all other chats.
    return this.db.prepare(`SELECT o.* FROM outbox o WHERE o.due<=? AND NOT EXISTS
      (SELECT 1 FROM outbox p WHERE p.key=o.key AND p.id<o.id) ORDER BY o.id LIMIT 1`).get(this.now());
  }
  delivered(id) { this.db.prepare('DELETE FROM outbox WHERE id=?').run(id); }
  retry(id, delay) { this.db.prepare('UPDATE outbox SET attempts=attempts+1,due=? WHERE id=?').run(this.now() + delay, id); }
  forget(key) {
    this.db.prepare('DELETE FROM sessions WHERE key=?').run(key);
    this.db.prepare('DELETE FROM outbox WHERE key=?').run(key);
    this.db.prepare('DELETE FROM limits WHERE key=?').run(key);
  }
  prune() {
    const now = this.now();
    this.db.prepare('DELETE FROM sessions WHERE expires<=?').run(now);
    this.db.prepare('DELETE FROM updates WHERE expires<=?').run(now);
    this.db.prepare('DELETE FROM limits WHERE expires<=?').run(now);
    // Never deliver potentially misleading old triage after a prolonged outage.
    const expired = this.db.prepare('DELETE FROM outbox WHERE created<=?').run(now - this.ttl).changes;
    this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    return expired;
  }
  stats() { return this.db.prepare('SELECT COUNT(*) AS pending,MIN(created) AS oldest FROM outbox').get(); }
  close() { this.db.close(); }
}
