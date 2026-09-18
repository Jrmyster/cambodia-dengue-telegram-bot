import test from 'node:test';
import assert from 'node:assert/strict';
import { callback, categorize, fresh, render, transition, WARNINGS } from '../src/flow.js';
import { locales } from '../locales.js';

const tap = (s, action, value = '') => transition(s, { data: callback(s, action, value) });
function begin(lang = 'en', fever = 'high', duration = 'typical') {
  let s = fresh();
  s = tap(s, 'language', lang).state;
  s = tap(s, 'begin').state;
  s = tap(s, 'fever', fever).state;
  return s.stage === 'duration' ? tap(s, 'duration', duration).state : s;
}

test('every warning sign immediately escalates, in both languages and every fever state', () => {
  for (const lang of ['en', 'km']) for (const fever of Object.keys(locales.en.feverChoices)) for (let index = 0; index < WARNINGS; index++) {
    let s = begin(lang, fever);
    for (let i = 0; i < index; i++) s = tap(s, 'warning', 'no').state;
    const result = tap(s, 'warning', 'yes');
    assert.equal(result.state.stage, 'result');
    assert.equal(result.state.result, 'red');
    assert.equal(result.messages[0].text, locales[lang].red);
    assert.deepEqual(result.state.answers, {});
  }
});
test('uncertain danger sign immediately stops questions for urgent assessment', () => {
  for (let i = 0; i < WARNINGS; i++) {
    let s = begin();
    for (let j = 0; j < i; j++) s = tap(s, 'warning', 'no').state;
    s = tap(s, 'warning', 'unsure').state;
    assert.equal(s.result, 'urgentYellow');
  }
});
test('all fever paths, duration boundaries and vulnerability/hydration combinations', () => {
  for (const lang of ['en', 'km']) for (const fever of Object.keys(locales.en.feverChoices)) {
    for (const duration of Object.keys(locales.en.durationChoices)) for (const vulnerable of ['yes', 'no', 'unsure']) for (const hydration of ['yes', 'no', 'unsure']) {
      let s = begin(lang, fever, duration);
      for (let i = 0; i < WARNINGS; i++) s = tap(s, 'warning', 'no').state;
      s = tap(s, 'vulnerable', vulnerable).state;
      s = tap(s, 'hydration', hydration).state;
      const urgent = vulnerable !== 'no' || hydration !== 'yes' || fever === 'unsure' || (fever !== 'none' && ['long', 'unsure'].includes(duration));
      assert.equal(s.result, urgent ? 'urgentYellow' : fever === 'none' ? 'green' : 'yellow');
    }
  }
});
test('no partial or invalid clinical assessment can become green', () => {
  assert.throws(() => categorize({ fever: 'none' }), /Incomplete/);
  assert.throws(() => categorize({ warnings: ['no'], fever: 'none' }), /Incomplete/);
  assert.equal(categorize({ warnings: ['yes'] }), 'red');
  const a = { warnings: Array(5).fill('no'), fever: 'high', vulnerable: 'no', hydration: 'yes' };
  assert.throws(() => categorize(a), /Incomplete duration/);
});
test('old and forged callbacks cannot move state; restart changes nonce', () => {
  const s = begin();
  const data = callback(s, 'warning', 'no');
  const next = transition(s, { data }).state;
  assert.deepEqual(transition(next, { data }).state, next);
  assert.equal(tap(s, 'hydration', 'yes').state.stage, 'warning');
  assert.equal(tap(s, 'warning', 'invalid').state.warning, 0);
  assert.notEqual(transition(s, { command: 'start' }).state.nonce, s.nonce);
  assert.equal(transition(null, { data }).state.stage, 'language');
});
test('utility commands work before onboarding and preserve an active assessment', () => {
  for (const command of ['emergency', 'prevention', 'help']) {
    const first = transition(null, { command });
    assert.match(first.messages[0].text, /119/);
    const chosen = tap(first.state, 'language', 'km');
    assert.equal(chosen.state.lang, 'km');
    assert.notEqual(chosen.messages[0].text, locales.km.intro);
  }
  const s = begin('km');
  assert.deepEqual(transition(s, { command: 'emergency' }).state, s);
  assert.deepEqual(transition(s, { command: 'prevention' }).state, s);
  assert.deepEqual(transition(s, { command: 'resume' }).messages, render(s));
  assert.equal(transition(s, { command: 'cancel' }).state, null);
});
function keys(o, prefix = '') {
  return Object.entries(o).flatMap(([k, v]) => v && typeof v === 'object' ? keys(v, `${prefix}${k}.`) : `${prefix}${k}`);
}
test('locale parity, Khmer Unicode, Telegram limits, and valid callback buttons', () => {
  assert.deepEqual(keys(locales.km), keys(locales.en));
  assert.match(locales.km.red, /[\u1780-\u17FF]/);
  for (const lang of ['en', 'km']) {
    let s = begin(lang);
    const screens = [...render(fresh()), ...render(s)];
    for (const stage of ['intro', 'fever', 'duration', 'vulnerable', 'hydration']) screens.push(...render({ ...s, stage }));
    for (const result of ['red', 'yellow', 'urgentYellow', 'green']) screens.push(...render({ ...s, stage: 'result', result }));
    for (const area of Object.keys(locales.en.areas)) screens.push(...tap(s, 'area', area).messages);
    screens.push(...transition(s, { command: 'prevention' }).messages);
    for (const m of screens) {
      assert.ok(m.text.length <= 4096, `${lang}: ${m.text.length} characters`);
      assert.ok(!m.text.includes('undefined'));
      for (const row of m.extra.reply_markup.inline_keyboard) for (const b of row) {
        assert.ok(b.text && (b.url || b.callback_data));
        if (b.callback_data) assert.ok(Buffer.byteLength(b.callback_data) <= 64);
        if (b.url) assert.equal(new URL(b.url).protocol, 'https:');
      }
    }
  }
});
