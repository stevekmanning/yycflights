import {
  listAllActiveAlerts, insertResultsBulk, touchAlertChecked,
  wasNotifiedRecently, recordNotification, getAlertPriceFloor,
  pruneExpiredAlerts,
} from '../db.js';
import { searchFlights } from './flights.js';
import { sendAlert } from '../mailer.js';
import { TAX_FACTOR, MANUAL_CHECK_DEBOUNCE_MS } from '../shared/constants.js';

// In-memory debounce: alertId → last manual check timestamp.
// Capped via periodic prune to prevent unbounded growth over long process life.
const recentManualChecks = new Map();
const DEBOUNCE_MS = MANUAL_CHECK_DEBOUNCE_MS;
let _lastPruneAt = 0;

function pruneManualChecks() {
  const now = Date.now();
  if (now - _lastPruneAt < DEBOUNCE_MS) return;
  _lastPruneAt = now;
  for (const [id, ts] of recentManualChecks) {
    if (now - ts > DEBOUNCE_MS) recentManualChecks.delete(id);
  }
}

/**
 * Check a single alert: search flights, store results, send email if threshold met.
 * Returns { alert, cheapest, alerted }
 */
export async function checkOneAlert(alert, { force = false } = {}) {
  pruneManualChecks();

  // Debounce manual checks
  if (!force) {
    const last = recentManualChecks.get(alert.id);
    if (last && Date.now() - last < DEBOUNCE_MS) {
      return { alert, cached: true, message: 'Checked recently — returning cached result' };
    }
  }

  recentManualChecks.set(alert.id, Date.now());

  const { results: offers } = await searchFlights({
    destination: alert.destination,
    monthStart:  alert.month_start,
    monthEnd:    alert.month_end,
    targetDate:  alert.target_date || null,
    flexDays:    alert.flex_days   ?? 0,
    stops:       alert.stops       ?? 0,
    tripType:    alert.trip_type   ?? 'round',
  });

  touchAlertChecked(alert.id);

  if (!offers.length) {
    return { alert, cheapest: null, alerted: false, offersFound: 0 };
  }

  // Store all offers in one transaction — 10–50× faster than row-by-row.
  // `offers` is pre-sorted ascending by price, so the first inserted ID is the
  // cheapest (stable even on ties).
  const cheapestOffer    = offers[0];
  const insertedIds      = insertResultsBulk(alert.id, offers);
  const cheapestResultId = insertedIds[0] ?? null;

  let alerted       = false;
  let triggerReason = null; // 'threshold' | 'deal' | null

  const mode = alert.alert_mode || 'threshold';

  if (mode === 'deal') {
    // Deal Watcher: trigger when price is ≥5% below the learned floor (P10),
    // provided we have enough samples to trust the baseline.
    const floor = getAlertPriceFloor(alert.id, 7);
    if (floor && cheapestOffer.price <= floor.p10 * 0.95) {
      triggerReason = 'deal';
    }
  } else {
    // Classic threshold mode (default)
    // Adjust effective threshold: if user set a base-fare budget, SerpApi
    // returns all-in price (taxes included), so we gross up before comparing.
    const effectiveThreshold = (alert.taxes_included === 0)
      ? alert.threshold * TAX_FACTOR
      : alert.threshold;

    if (cheapestOffer.price < effectiveThreshold) triggerReason = 'threshold';
  }

  if (triggerReason) {
    if (!wasNotifiedRecently(alert.id)) {
      try {
        await sendAlert({ alert, result: cheapestOffer, reason: triggerReason });
        recordNotification(alert.id, cheapestResultId);
        alerted = true;
      } catch (err) {
        console.error(`[flightChecker] Failed to send alert for alert ${alert.id}:`, err.message);
      }
    } else {
      console.log(`[flightChecker] Alert ${alert.id} already notified within 24h, skipping email`);
    }
  }

  return { alert, cheapest: cheapestOffer, alerted, offersFound: offers.length, triggerReason };
}

/**
 * Run checks for all active alerts. Used by the cron scheduler.
 * Expired alerts are archived in one bulk SQL call before we search anything,
 * so we don't waste SerpApi credits on trips past their book-by date.
 */
export async function runAllChecks() {
  const archived = pruneExpiredAlerts();
  if (archived > 0) console.log(`[flightChecker] Archived ${archived} expired alert(s)`);

  const alerts = listAllActiveAlerts();
  let checked  = 0;
  let alerted  = 0;

  for (const alert of alerts) {
    try {
      const result = await checkOneAlert(alert, { force: true });
      checked++;
      if (result.alerted) alerted++;
    } catch (err) {
      console.error(`[flightChecker] Error checking alert ${alert.id} (${alert.dest_label}):`, err.message);
    }
  }

  return { checked, alerted, archived };
}
