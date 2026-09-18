import { coarseLocation, PROVINCES } from './analytics.js';

const msg = (text, rows) => ({ text, extra: { reply_markup: { inline_keyboard: rows }, link_preview_options: { is_disabled: true } } });
const btn = (s, text, action, value = '') => ({ text, callback_data: `${s.nonce}:${s.rev}:${action}:${value}` });
const exitRows = (s, t) => [[btn(s, t.resume, 'resume')], [btn(s, t.emergency, 'emergency')], [btn(s, t.cancel, 'cancel')]];

export function renderLocation(s, t) {
  if (s.locationRequest?.step === 'pin') return pinPrompt(s, t).messages;
  const buttons = PROVINCES.map(p => btn(s, t.provinces[p], 'province', p));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return [msg(`${t.locationPrompt}\n\n${t.locationPrivacy}\n\n${t.chooseProvince}`, [...rows, ...exitRows(s, t)])];
}

export function startLocation(s, t) {
  s.rev++;
  s.locationRequest = { step: 'province' };
  return { state: s, messages: renderLocation(s, t) };
}

export function pinPrompt(s, t, prefix = '') {
  return { state: s, messages: [msg(`${prefix}${t.sendPin}`, [
    [btn(s, t.provinceOnly, 'province_only')], ...exitRows(s, t),
  ])] };
}

export function locationTransition(s, t, action, value, event) {
  if (action === 'location') return startLocation(s, t);
  if (action === 'province' && s.locationRequest?.step === 'province' && PROVINCES.includes(value)) {
    s.locationRequest = { step: 'pin', province: value }; s.rev++;
    return pinPrompt(s, t);
  }
  if (action !== 'location_pin' && action !== 'province_only') return null;
  if (s.locationRequest?.step !== 'pin') return startLocation(s, t); // Discard unsolicited pins.
  const coarse = action === 'province_only' ? { cell: 'province_only', latitude: null, longitude: null } : coarseLocation(event.location);
  if (!coarse) return pinPrompt(s, t, `${t.invalidPin}\n\n`);
  const locationReport = { ...coarse, province: s.locationRequest.province };
  delete s.locationRequest; s.rev++;
  // Neither coordinates nor a report identifier enter the persisted session/reply.
  return { state: s, locationReport, messages: [msg(t.locationSaved, exitRows(s, t))] };
}
