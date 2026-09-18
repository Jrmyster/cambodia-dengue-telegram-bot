import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { callback, render, transition, fresh } from '../src/flow.js';
import { aggregateReport, coarseLocation, dailyAnalyticsHash, DAY, PROVINCES, reportingDay } from '../src/analytics.js';
import { locales } from '../locales.js';

const NOW = Date.parse('2026-09-18T03:12:45Z');
const PIN = { latitude: 11.556417, longitude: 104.928263 };
let updateId = 10000;
function client(db, id = 99887766) {
  const send = event => db.accept(++updateId, id, event);
  return { id, send, command: command => send({ command }),
    tap: (action, value = '') => send({ data: callback(db.get(id), action, value) }),
    pin: (location = PIN) => send({ command: 'location_pin', location }) };
}
function open(db, id, lang = 'en') {
  const c = client(db, id); c.command('start'); c.tap('language', lang); return c;
}
function invite(c, province = 'pp') { c.command('location'); c.tap('province', province); }
function outcome(c, result = 'red') {
  c.tap('begin'); c.tap('fever', result === 'green' ? 'none' : 'high');
  if (result !== 'green') c.tap('duration', 'typical');
  if (result === 'red' || result === 'urgentYellow') return c.tap('warning', result === 'red' ? 'yes' : 'unsure');
  for (let i = 0; i < 5; i++) c.tap('warning', 'no');
  c.tap('vulnerable', 'no'); c.tap('hydration', 'yes');
}
function memory(t, now = () => NOW) {
  const db = new Store(':memory:', 'test-analytics-secret', 1800000, now); t.after(() => db.close()); return db;
}
const rows = (db, table) => db.db.prepare(`SELECT * FROM ${table}`).all();

test('daily HMAC is secret-keyed and separated by account, Cambodia day and purpose', () => {
  const hash = dailyAnalyticsHash('secret', 42, NOW, 'location');
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(hash, dailyAnalyticsHash('secret', 42, NOW + 60000, 'location'));
  assert.notEqual(hash, dailyAnalyticsHash('other-secret', 42, NOW, 'location'));
  assert.notEqual(hash, dailyAnalyticsHash('secret', 43, NOW, 'location'));
  assert.notEqual(hash, dailyAnalyticsHash('secret', 42, NOW + DAY, 'location'));
  assert.notEqual(hash, dailyAnalyticsHash('secret', 42, NOW, 'RED_FLAG_ESCALATION'));
  assert.notEqual(hash, createHash('sha256').update('42').digest('hex'));
  const before = Date.parse('2026-09-18T16:59:59Z');
  assert.equal(reportingDay(before).day, '2026-09-18');
  assert.equal(reportingDay(before + 1000).day, '2026-09-19');
  assert.notEqual(dailyAnalyticsHash('secret', 42, before, 'x'), dailyAnalyticsHash('secret', 42, before + 1000, 'x'));
});

test('grid conversion validates input and retains only coarse cell centers', () => {
  const coarse = coarseLocation(PIN);
  assert.equal(coarse.latitude, 11.55); assert.equal(coarse.longitude, 104.95);
  assert.deepEqual(coarse, coarseLocation({ latitude: 11.56, longitude: 104.93 }));
  for (const bad of [null, {}, { latitude: NaN, longitude: 1 }, { latitude: Infinity, longitude: 1 },
    { latitude: '11.5', longitude: 104.9 }, { latitude: 91, longitude: 0 }, { latitude: 0, longitude: -181 },
    { ...PIN, live: true }, { ...PIN, forwarded: true }]) assert.equal(coarseLocation(bad), null);
  assert.equal(coarseLocation({ latitude: 90, longitude: 180 }).latitude, 89.95);
  assert.equal(coarseLocation({ latitude: -90, longitude: -180 }).longitude, -179.95);
});

test('SQLite stores daily detached coarse location counts and no input identity or raw pin', t => {
  const db = memory(t), c = open(db);
  invite(c); c.pin({ ...PIN, username: 'PRIVATE_NAME', phone_number: 'PRIVATE_PHONE', user_id: c.id });
  const [entry] = rows(db, 'location_reports');
  assert.equal(entry.day, '2026-09-18'); assert.equal(entry.recorded_at, reportingDay(NOW).start);
  assert.equal(entry.latitude, 11.55); assert.equal(entry.longitude, 104.95);
  assert.equal(entry.province, 'pp'); assert.equal(entry.report_count, 1);
  assert.equal(db.get(c.id).locationRequest, undefined);
  assert.deepEqual(Object.keys(entry), ['day', 'recorded_at', 'province', 'cell', 'latitude', 'longitude', 'report_count']);
  const reportData = JSON.stringify([entry, ...rows(db, 'analytics_events'), ...rows(db, 'analytics_dedup')]);
  for (const forbidden of [String(c.id), 'PRIVATE_NAME', 'PRIVATE_PHONE', String(PIN.latitude), String(PIN.longitude), db.key(c.id)]) assert.ok(!reportData.includes(forbidden));
  const stateAndReplies = JSON.stringify([db.get(c.id), ...rows(db, 'outbox')]);
  assert.ok(!stateAndReplies.includes(String(PIN.latitude)));
  assert.ok(!stateAndReplies.includes(String(PIN.longitude)));
  assert.deepEqual(Object.keys(rows(db, 'analytics_dedup')[0]), ['daily_hash', 'expires']);
});

test('no consent, missing province, expired consent and live/forwarded pins are not recorded', t => {
  let now = NOW; const db = memory(t, () => now), c = client(db);
  c.pin(); assert.equal(rows(db, 'location_reports').length, 0);
  c.tap('language', 'km'); c.pin(); assert.equal(rows(db, 'location_reports').length, 0);
  c.tap('province', 'pp');
  c.pin({ ...PIN, live: true }); c.pin({ ...PIN, forwarded: true });
  assert.equal(rows(db, 'location_reports').length, 0);
  now += 1800001; c.pin();
  assert.equal(rows(db, 'location_reports').length, 0);
  assert.equal(db.get(c.id).stage, 'language');
});

test('province only, skip and cancel work without coordinates', t => {
  const db = memory(t), c = open(db, 101, 'km');
  invite(c, 'sr'); c.tap('province_only');
  const entry = rows(db, 'location_reports')[0];
  assert.equal(entry.province, 'sr'); assert.equal(entry.latitude, null); assert.equal(entry.longitude, null);
  invite(c); c.command('resume'); c.pin(); assert.equal(rows(db, 'location_reports').length, 1);
  invite(c); c.command('cancel'); c.pin(); assert.equal(rows(db, 'location_reports').length, 1);
});

test('one location per account/day across restarts, distinct accounts aggregate together', t => {
  let now = NOW; const db = memory(t, () => now), c = open(db);
  invite(c); c.pin();
  c.command('start'); c.tap('language', 'en'); invite(c, 'sr'); c.pin({ latitude: 13.4, longitude: 103.9 });
  assert.equal(rows(db, 'location_reports').length, 1);
  assert.equal(rows(db, 'location_reports')[0].report_count, 1);
  const second = open(db, 202); invite(second); second.pin();
  assert.equal(rows(db, 'location_reports')[0].report_count, 2);
  now += DAY; c.command('start'); c.tap('language', 'en'); invite(c); c.pin();
  assert.equal(rows(db, 'location_reports').length, 2);
});

test('all completed triage outcomes are counted once; resumes, stale buttons and utilities do not recount', t => {
  const db = memory(t);
  for (const [index, result] of ['red', 'yellow', 'green', 'urgentYellow'].entries()) {
    const c = open(db, 1000 + index); outcome(c, result);
    const snapshot = JSON.stringify(rows(db, 'analytics_events'));
    c.command('resume'); c.command('help');
    c.send({ data: 'expired:0:warning:yes' });
    assert.equal(JSON.stringify(rows(db, 'analytics_events')), snapshot);
  }
  const events = rows(db, 'analytics_events');
  assert.deepEqual(new Set(events.map(e => e.event_type)), new Set(['RED_FLAG_ESCALATION', 'YELLOW_MONITORING', 'GREEN_PREVENTION', 'URGENT_ASSESSMENT']));
  for (const e of events) { assert.equal(e.count, 1); assert.equal(e.region, 'unknown'); }
  const again = open(db, 1000); outcome(again, 'red');
  assert.equal(rows(db, 'analytics_events').find(e => e.event_type === 'RED_FLAG_ESCALATION').count, 2);
});

test('referral demand is labelled requested care area, never inferred as patient residence', t => {
  const db = memory(t), c = open(db);
  c.command('referral'); c.tap('area', 'bb'); c.tap('area', 'bb');
  const events = rows(db, 'analytics_events');
  assert.equal(events.length, 2);
  assert.equal(events.find(e => e.region === 'bb').region_basis, 'requested_care_area');
  assert.equal(events.find(e => e.region === 'bb').count, 1);
  assert.equal(rows(db, 'location_reports').length, 0);
  assert.equal(db.get(c.id).locationRequest, undefined);
});

test('duplicate Telegram deliveries and failed transaction retries cannot inflate analytics', t => {
  const db = memory(t), c = open(db); invite(c);
  const id = ++updateId, event = { command: 'location_pin', location: PIN };
  db.db.exec("CREATE TRIGGER fail_reply BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'test failure'); END");
  assert.throws(() => db.accept(id, c.id, event));
  assert.equal(rows(db, 'location_reports').length, 0); assert.equal(rows(db, 'analytics_dedup').length, 0);
  assert.equal(db.get(c.id).locationRequest.step, 'pin');
  db.db.exec('DROP TRIGGER fail_reply');
  assert.equal(db.accept(id, c.id, event), 'accepted');
  assert.equal(db.accept(id, c.id, event), 'duplicate');
  assert.equal(rows(db, 'location_reports')[0].report_count, 1);
});

test('new location requests cannot delete unsent red emergency advice', t => {
  const db = memory(t), c = open(db); outcome(c);
  const red = db.next(); assert.match(JSON.parse(red.payload).text, /🔴/);
  c.pin(); assert.equal(db.next().id, red.id);
  assert.equal(rows(db, 'analytics_events')[0].count, 1);
});

test('aggregate reports suppress counts below five and prohibit current-day/differencing reports', t => {
  const db = memory(t);
  for (let i = 0; i < 4; i++) { const c = open(db, 400 + i); outcome(c); invite(c); c.pin(); }
  assert.equal(aggregateReport(db.db, '2026-09-18', NOW + DAY).events.length, 0);
  assert.equal(aggregateReport(db.db, '2026-09-18', NOW + DAY).locations.length, 0);
  const c = open(db, 404); outcome(c); invite(c); c.pin();
  const report = aggregateReport(db.db, '2026-09-18', NOW + DAY);
  assert.equal(report.events[0].count, 5); assert.equal(report.locations[0].report_count, 5);
  assert.ok(!JSON.stringify(report).includes('daily_hash'));
  assert.throws(() => aggregateReport(db.db, '2026-09-18', NOW));
  assert.throws(() => aggregateReport(db.db, '2026-02-30', NOW));
  assert.throws(() => aggregateReport(db.db, "2026-09-17' OR 1=1", NOW));
  assert.equal(aggregateReport(db.db, '2026-09-18', NOW + 90 * DAY).locations.length, 0);
  assert.equal(aggregateReport(db.db, '2026-09-18', NOW + 365 * DAY).events.length, 0);
});

test('retention prunes short-lived hashes, old locations and old event counts', t => {
  let now = NOW; const db = memory(t, () => now), c = open(db);
  outcome(c); invite(c); c.pin();
  now += 2 * DAY; db.prune();
  assert.equal(rows(db, 'analytics_dedup').length, 0);
  assert.equal(rows(db, 'location_reports').length, 1);
  now = NOW + 90 * DAY; db.prune();
  assert.equal(rows(db, 'location_reports').length, 0); assert.equal(rows(db, 'analytics_events').length, 1);
  now = NOW + 365 * DAY; db.prune(); assert.equal(rows(db, 'analytics_events').length, 0);
});

test('existing databases upgrade additively and retain reports/dedup after reopen', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dengue-analytics-')), path = join(dir, 'bot.sqlite');
  let db;
  t.after(() => { db?.close(); rmSync(dir, { recursive: true, force: true }); });
  const old = new DatabaseSync(path);
  old.exec('CREATE TABLE sessions (key TEXT PRIMARY KEY, state TEXT NOT NULL, expires INTEGER NOT NULL)');
  old.prepare('INSERT INTO sessions VALUES (?,?,?)').run('legacy-key', JSON.stringify({ marker: true }), NOW + DAY); old.close();
  db = new Store(path, 'stable-secret', 1800000, () => NOW);
  assert.ok(db.db.prepare("SELECT 1 FROM sessions WHERE key='legacy-key'").get());
  const c = open(db); invite(c); c.pin();
  db.close(); db = new Store(path, 'stable-secret', 1800000, () => NOW);
  const resumed = client(db); invite(resumed); resumed.pin();
  assert.equal(rows(db, 'location_reports')[0].report_count, 1);
});

test('location keyboards are bilingual, complete and within Telegram limits; stale consent is inert', () => {
  for (const lang of ['en', 'km']) {
    assert.deepEqual(Object.keys(locales[lang].provinces), PROVINCES);
    let s = fresh(); s = transition(s, { data: callback(s, 'language', lang) }).state;
    s = transition(s, { command: 'location' }).state;
    const oldProvince = callback(s, 'province', 'pp');
    const prompt = render(s)[0];
    assert.ok(prompt.text.length <= 4096);
    for (const row of prompt.extra.reply_markup.inline_keyboard) for (const b of row) assert.ok(Buffer.byteLength(b.callback_data) <= 64);
    s = transition(s, { data: oldProvince }).state;
    assert.ok(transition(s, { data: oldProvince }).messages[0].text.includes(locales[lang].stale));
    assert.equal(s.locationRequest.province, 'pp');
    const originalStage = s.stage;
    s = transition(s, { command: 'resume' }).state;
    assert.equal(s.stage, originalStage); assert.equal(s.locationRequest, undefined);
  }
});

test('report CLI emits only eligible aggregates from an existing database without modifying it', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dengue-report-')), path = join(dir, 'bot.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const yesterday = Date.now() - DAY;
  const db = new Store(path, 'cli-test-secret', 1800000, () => yesterday);
  try {
    for (let i = 0; i < 5; i++) { const c = open(db, 600 + i); outcome(c); invite(c); c.pin(); }
  } finally { db.close(); }
  const before = readFileSync(path);
  const output = execFileSync(process.execPath,
    [fileURLToPath(new URL('../scripts/report.js', import.meta.url)), '--date', reportingDay(yesterday).day],
    { env: { ...process.env, DATABASE_PATH: path }, encoding: 'utf8' });
  const report = JSON.parse(output);
  assert.equal(report.events[0].count, 5); assert.equal(report.locations[0].report_count, 5);
  assert.ok(!output.includes('daily_hash')); assert.ok(!output.includes(String(PIN.latitude)));
  assert.deepEqual(readFileSync(path), before);
});
