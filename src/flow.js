import { randomBytes } from 'node:crypto';
import { common, locales } from '../locales.js';
import { directory } from './referrals.js';

export const WARNINGS = 5;
export const fresh = () => ({ nonce: randomBytes(6).toString('hex'), rev: 0, stage: 'language', lang: null, answers: {}, warning: 0 });
export const callback = (s, action, value = '') => `${s.nonce}:${s.rev}:${action}:${value}`;
const button = (s, text, action, value) => ({ text, callback_data: callback(s, action, value) });
const message = (text, rows = []) => ({ text, extra: { reply_markup: { inline_keyboard: rows }, link_preview_options: { is_disabled: true } } });
const langs = s => [[button(s, '🇰🇭 ភាសាខ្មែរ', 'language', 'km')], [button(s, '🇬🇧 English', 'language', 'en')]];
const nav = (s, t) => [[button(s, t.emergency, 'emergency')], [button(s, t.cancel, 'cancel')]];
const home = (s, t) => [[button(s, t.restart, 'start')], [button(s, t.prevention, 'prevention')], ...nav(s, t)];
const yesNo = (s, t, action) => ['yes', 'no', 'unsure'].map(v => [button(s, t[v], action, v)]);

// Referral tiers are a conservative product policy, NOT a validated WHO score.
export function categorize(a) {
  if (a.warnings?.includes('yes')) return 'red';
  if (!Array.isArray(a.warnings) || a.warnings.length !== WARNINGS || a.warnings.some(v => !['no', 'unsure'].includes(v))) throw new Error('Incomplete warning screen');
  if (a.warnings.includes('unsure') || a.vulnerable !== 'no' || a.hydration !== 'yes' ||
      a.duration === 'long' || a.duration === 'unsure' || a.fever === 'unsure') return 'urgentYellow';
  if (!['high', 'mild', 'falling', 'none'].includes(a.fever)) throw new Error('Incomplete fever screen');
  if (a.fever !== 'none' && !['short', 'typical'].includes(a.duration)) throw new Error('Incomplete duration');
  // Even mild fever can be dengue; green is deliberately limited to no recent fever.
  return a.fever === 'none' ? 'green' : 'yellow';
}

export function render(s) {
  if (!s.lang) return [message(`${common.chooseLanguage}\n\n${common.urgent}`, langs(s))];
  const t = locales[s.lang];
  switch (s.stage) {
    case 'intro': return [message(t.intro, [[button(s, t.begin, 'begin')], ...nav(s, t)])];
    case 'fever': return [message(t.fever, [...Object.entries(t.feverChoices).map(([v, text]) => [button(s, text, 'fever', v)]), ...nav(s, t)])];
    case 'duration': return [message(t.duration, [...Object.entries(t.durationChoices).map(([v, text]) => [button(s, text, 'duration', v)]), ...nav(s, t)])];
    case 'warning': return [message(`${t.warningIntro}\n\n${s.warning + 1}/${WARNINGS}: ${t.warnings[s.warning]}`, [...yesNo(s, t, 'warning'), ...nav(s, t)])];
    case 'vulnerable': return [message(t.vulnerable, [...yesNo(s, t, 'vulnerable'), ...nav(s, t)])];
    case 'hydration': return [message(t.hydration, [...yesNo(s, t, 'hydration'), ...nav(s, t)])];
    case 'result': return [message(s.result === 'red' ? t.red : `${t[s.result]}\n\n${t.care}`, home(s, t))];
    default: return [message(t.help, home(s, t))];
  }
}

function emergency(s, area) {
  const t = locales[s.lang];
  const rows = Object.entries(t.areas).map(([v, text]) => [button(s, text, 'area', v)]);
  if (!area) return [message(t.emergencyIntro, [...rows, [button(s, t.resume, 'resume')]])];
  const d = directory(area, s.lang, t);
  return [message(`${t.emergencyIntro.split('\n\n')[0]}\n\n${d.text}`, [...d.buttons, [button(s, t.back, 'emergency')], [button(s, t.resume, 'resume')]])];
}

function finish(s, result) {
  s.stage = 'result'; s.result = result;
  s.answers = {}; // No symptom history retained after categorization.
}

// Synchronous pure transition: only Store applies/persists its output atomically.
export function transition(current, event) {
  let s = current ? structuredClone(current) : fresh();
  let action = event.command;
  let value = '';
  if (event.data) {
    const parts = event.data.split(':');
    if (parts.length !== 4 || parts[0] !== s.nonce || parts[1] !== String(s.rev)) {
      return { state: s, messages: current ? [message(locales[s.lang || 'en'].stale), ...render(s)] : render(s) };
    }
    [, , action, value] = parts;
  }
  if (action === 'cancel') {
    return { state: null, clear: true, messages: [message(s.lang ? locales[s.lang].cleared : `${locales.km.cleared}\n\n${locales.en.cleared}`)] };
  }
  if (action === 'start') { s = fresh(); return { state: s, clear: true, messages: render(s) }; }
  if (!s.lang && action !== 'language') {
    s.pending = ['emergency', 'prevention', 'help'].includes(action) ? action : 'intro';
    // /emergency delivers ambulance guidance BEFORE asking for language.
    return { state: s, messages: render(s) };
  }
  if (action === 'language' && s.stage === 'language' && ['en', 'km'].includes(value)) {
    s.lang = value; s.stage = 'intro'; s.rev++;
    const pending = s.pending; delete s.pending;
    if (pending === 'emergency') return { state: s, messages: emergency(s) };
    if (pending === 'prevention' || pending === 'help') return { state: s, messages: [message(locales[s.lang][pending === 'help' ? 'help' : 'preventionText'], home(s, locales[s.lang]))] };
    return { state: s, messages: render(s) };
  }
  const t = locales[s.lang || 'en'];
  if (action === 'emergency') return { state: s, messages: emergency(s) };
  if (action === 'area' && Object.hasOwn(t.areas, value)) return { state: s, messages: emergency(s, value) };
  if (action === 'prevention' || action === 'help') return { state: s, messages: [message(t[action === 'help' ? 'help' : 'preventionText'], [[button(s, t.resume, 'resume')], ...home(s, t)])] };
  if (action === 'resume') return { state: s, messages: render(s) };
  let valid = true;
  if (action === 'begin' && s.stage === 'intro') s.stage = 'fever';
  else if (action === 'fever' && s.stage === 'fever' && Object.hasOwn(t.feverChoices, value)) {
    s.answers.fever = value; s.stage = value === 'none' ? 'warning' : 'duration';
    s.answers.warnings = [];
  } else if (action === 'duration' && s.stage === 'duration' && Object.hasOwn(t.durationChoices, value)) {
    s.answers.duration = value; s.stage = 'warning';
  } else if (action === 'warning' && s.stage === 'warning' && ['yes', 'no', 'unsure'].includes(value)) {
    s.answers.warnings.push(value);
    if (value === 'yes') finish(s, 'red');
    else if (value === 'unsure') finish(s, 'urgentYellow');
    else if (++s.warning === WARNINGS) s.stage = 'vulnerable';
  } else if (action === 'vulnerable' && s.stage === 'vulnerable' && ['yes', 'no', 'unsure'].includes(value)) {
    s.answers.vulnerable = value; s.stage = 'hydration';
  } else if (action === 'hydration' && s.stage === 'hydration' && ['yes', 'no', 'unsure'].includes(value)) {
    s.answers.hydration = value; finish(s, categorize(s.answers));
  } else valid = false;
  if (valid) s.rev++;
  return { state: s, messages: [...(!valid ? [message(t.fallback)] : []), ...render(s)] };
}
