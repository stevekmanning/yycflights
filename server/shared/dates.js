// Timezone-safe date helpers.
//
// Rationale: Google Flights / SerpApi speak YYYY-MM-DD date strings that
// represent *calendar* dates (no timezone). Mixing `new Date('YYYY-MM-DD')`
// (which parses as UTC midnight) with `.toISOString()` in Mountain Time
// (UTC-6/-7) leaks the wrong day. These helpers stay in the server's local
// timezone for formatting and re-read strings as noon-local to dodge DST
// transition-day bugs.

import { SHORT_MONTHS } from './constants.js';

/** Format a Date as YYYY-MM-DD in LOCAL time (not UTC). */
export function toYmd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Parse YYYY-MM-DD as a Date at NOON local time.
 * Using noon instead of midnight dodges DST boundary weirdness
 * (on spring-forward days, midnight local doesn't exist).
 */
export function parseYmdNoon(ymd) {
  if (!ymd) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
}

/** Add N days to a YYYY-MM-DD string, return a new YYYY-MM-DD string. */
export function addDaysYmd(ymd, days) {
  const d = parseYmdNoon(ymd);
  if (!d) return ymd;
  d.setDate(d.getDate() + days);
  return toYmd(d);
}

/** Today's date in LOCAL time as YYYY-MM-DD. */
export function todayYmd() {
  return toYmd(new Date());
}

/**
 * Pretty-print a YYYY-MM-DD (or ISO timestamp) as "Jun 15, 2026".
 * Works from a pure date string without timezone shifting.
 */
export function fmtHumanDate(ymdOrIso) {
  if (!ymdOrIso) return '—';
  // Accept either 'YYYY-MM-DD' or a full ISO timestamp. For pure dates we parse
  // at noon-local; for ISO timestamps with offset we let Date handle it.
  const ymdOnly = /^\d{4}-\d{2}-\d{2}$/.test(ymdOrIso);
  const d = ymdOnly ? parseYmdNoon(ymdOrIso) : new Date(ymdOrIso);
  if (!d || Number.isNaN(d.getTime())) return '—';
  return `${SHORT_MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/**
 * Long format: "Monday, June 15, 2026". Same timezone-safe guarantees.
 */
export function fmtLongDate(ymdOrIso) {
  if (!ymdOrIso) return '—';
  const ymdOnly = /^\d{4}-\d{2}-\d{2}$/.test(ymdOrIso);
  const d = ymdOnly ? parseYmdNoon(ymdOrIso) : new Date(ymdOrIso);
  if (!d || Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-CA', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}
