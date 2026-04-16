import { listAllActiveAlerts, insertResult, touchAlertChecked, wasNotifiedRecently, recordNotification, updateAlert, getAlertPriceFloor } from '../db.js';
import { searchFlights } from './flights.js';
import { sendAlert } from '../mailer.js';

// In-memory debounce: alertId → last manual check timestamp
const recentManualChecks = new Map();
const DEBOUNCE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Check a single alert: search flights, store results, send email if threshold met.
 * Returns { alert, cheapest, alerted }
 */
export async function checkOneAlert(alert, { force = false } = {}) {
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

  // Store all offers, track the cheapest inserted ID
  let cheapestResultId = null;
  let cheapestOffer    = offers[0];

  for (const offer of offers) {
    const id = insertResult({ alert_id: alert.id, ...offer });
    if (offer === cheapestOffer) cheapestResultId = id;
  }

  let alerted    = false;
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
    // Adjust effective threshold: if user set a base-fare budget, SerpApi returns
    // all-in price (taxes included), so we gross up by ~15% for comparison.
    const TAX_FACTOR = 1.15;
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
 * Returns { checked, alerted }.
 */
export async function runAllChecks() {
  const today  = new Date().toISOString().slice(0, 10);
  const alerts = listAllActiveAlerts();
  let checked  = 0;
  let alerted  = 0;

  for (const alert of alerts) {
    // Auto-skip expired alerts (book_by date has passed)
    if (alert.book_by && alert.book_by < today) {
      console.log(`[flightChecker] Expiring alert ${alert.id} (${alert.dest_label}) — book_by ${alert.book_by} has passed`);
      updateAlert(alert.id, { active: 0 });
      continue;
    }
    try {
      const result = await checkOneAlert(alert, { force: true });
      checked++;
      if (result.alerted) alerted++;
    } catch (err) {
      console.error(`[flightChecker] Error checking alert ${alert.id} (${alert.dest_label}):`, err.message);
    }
  }

  return { checked, alerted };
}
