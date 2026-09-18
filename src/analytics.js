import { createHmac } from 'node:crypto';

export const DAY = 86400000;
const CAMBODIA_OFFSET = 7 * 3600000;
export const MIN_REPORT_COUNT = 5;
export const LOCATION_RETENTION_DAYS = 90;
export const EVENT_RETENTION_DAYS = 365;
export const OUTCOME_EVENTS = Object.freeze({
  red: 'RED_FLAG_ESCALATION', yellow: 'YELLOW_MONITORING',
  urgentYellow: 'URGENT_ASSESSMENT', green: 'GREEN_PREVENTION',
});
export const EVENT_TYPES = Object.freeze([...Object.values(OUTCOME_EVENTS), 'REFERRAL_CONTACT_REQUEST']);
export const PROVINCES = Object.freeze([
  'banteay_meanchey', 'bb', 'kc', 'kampong_chhnang', 'kampong_speu', 'kampong_thom',
  'kampot', 'kandal', 'kep', 'koh_kong', 'kratie', 'mondulkiri', 'oddar_meanchey',
  'pailin', 'pp', 'preah_sihanouk', 'preah_vihear', 'prey_veng', 'pursat',
  'ratanakiri', 'sr', 'stung_treng', 'svay_rieng', 'takeo', 'tboung_khmum', 'unknown',
]);

// Timestamp is deliberately reduced to midnight in Asia/Phnom_Penh (UTC+7).
export function reportingDay(now) {
  if (!Number.isFinite(now)) throw new Error('Invalid reporting timestamp');
  const start = Math.floor((now + CAMBODIA_OFFSET) / DAY) * DAY - CAMBODIA_OFFSET;
  return { day: new Date(start + CAMBODIA_OFFSET).toISOString().slice(0, 10), start };
}

// Pseudonymous, not anonymous: only short-lived dedup uses this value. It is NEVER
// stored in event/location aggregates, reports, sessions or logs. Domain separation
// prevents joining it to the operational session key or to other event categories.
export function dailyAnalyticsHash(secret, chatId, now, purpose) {
  if (!Number.isSafeInteger(chatId) || typeof purpose !== 'string' || !purpose) throw new Error('Invalid dedup input');
  return createHmac('sha256', secret)
    .update(JSON.stringify(['analytics-dedup-v1', reportingDay(now).day, purpose, String(chatId)]))
    .digest('hex');
}

export function coarseLocation(location) {
  if (!location || location.live || location.forwarded) return null;
  const { latitude, longitude } = location;
  if (typeof latitude !== 'number' || typeof longitude !== 'number' ||
      !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  // 0.1-degree grid cells (~11 km north/south). Clamp the geographic maxima
  // into the last valid cell; only the center is retained, never the raw pin.
  const latCell = Math.min(1799, Math.floor((latitude + 90) * 10));
  const lonCell = Math.min(3599, Math.floor((longitude + 180) * 10));
  return {
    cell: `${latCell}:${lonCell}`,
    latitude: Number((-90 + latCell / 10 + 0.05).toFixed(2)),
    longitude: Number((-180 + lonCell / 10 + 0.05).toFixed(2)),
  };
}

// Read-only reports contain completed days only and suppress every count < 5.
// This is an internal report, not a guarantee against statistical reidentification.
export function aggregateReport(db, day, now = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(`${day}T00:00:00Z`)) ||
      new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day || day >= reportingDay(now).day) {
    throw new Error('Choose a valid completed reporting day (YYYY-MM-DD)');
  }
  const today = reportingDay(now).start;
  return {
    day, timezone: 'Asia/Phnom_Penh', minimum_count: MIN_REPORT_COUNT,
    interpretation: 'Bot usage and voluntary reports, not confirmed dengue cases or measured vector risk. Missing cells may be suppressed; do not treat them as zero.',
    events: db.prepare(`SELECT event_type, region, region_basis, count FROM analytics_events
      WHERE day=? AND count>=? AND recorded_at>? ORDER BY event_type, region, region_basis`)
      .all(day, MIN_REPORT_COUNT, today - EVENT_RETENTION_DAYS * DAY),
    locations: db.prepare(`SELECT province, latitude, longitude, report_count FROM location_reports
      WHERE day=? AND report_count>=? AND recorded_at>? ORDER BY province, cell`)
      .all(day, MIN_REPORT_COUNT, today - LOCATION_RETENTION_DAYS * DAY),
  };
}
