// Shared constants used across server + (mirrored in) client.
// Keep this file tiny and dependency-free.

// SerpApi returns all-in prices (taxes + fees included). If a user's budget is
// a base-fare (taxes_included === 0), gross it up by this multiplier before
// comparing to results. ~15% reflects typical CAD international long-haul tax load.
export const TAX_FACTOR = 1.15;

// Short month names — used by digest HTML and any server-rendered date strings.
export const SHORT_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// Notification dedup window — don't re-email same alert within this window.
export const NOTIFY_DEDUP_HOURS = 24;

// Manual-check debounce — prevents UI "check now" button from hammering SerpApi.
export const MANUAL_CHECK_DEBOUNCE_MS = 10 * 60 * 1000;
