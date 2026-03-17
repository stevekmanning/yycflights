/**
 * advisor.js — Price trend analysis and smart buy recommendation engine.
 *
 * computeTrend(history)        — linear regression on daily-min prices
 * generateAdvice(trend, alert) — buy/wait recommendation with deadline + booking-window intelligence
 */

/**
 * Ordinary least-squares linear regression on (x, y) pairs.
 */
function linearRegression(points) {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: points[0]?.y ?? 0 };

  const sumX  = points.reduce((s, p) => s + p.x, 0);
  const sumY  = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumX2 = points.reduce((s, p) => s + p.x * p.x, 0);

  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: sumY / n };

  const slope     = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

/**
 * Compute trend statistics from price history rows.
 * @param {Array<{day: string, min_price: number}>} history  oldest-first
 * @returns {object|null}  null if fewer than 2 data points
 */
export function computeTrend(history) {
  if (!history || history.length < 2) return null;

  const n      = history.length;
  const prices = history.map(r => r.min_price);

  const points = history.map((_, i) => ({ x: i, y: history[i].min_price }));
  const { slope: slopePerObs, intercept } = linearRegression(points);

  // Convert slope: CAD/observation → CAD/day using actual calendar span
  const firstDay  = new Date(history[0].day);
  const lastDay   = new Date(history[n - 1].day);
  const daySpan   = Math.max(1, (lastDay - firstDay) / 86_400_000);
  const slopePerDay = slopePerObs * (n - 1) / daySpan;

  const avg     = prices.reduce((s, p) => s + p, 0) / n;
  const min     = Math.min(...prices);
  const max     = Math.max(...prices);
  const current = prices[n - 1];

  // Projected price N days after the last observation
  const projectDaysOut = (days) => Math.round(current + slopePerDay * days);

  let direction;
  if      (slopePerDay >  1) direction = 'rising';
  else if (slopePerDay < -1) direction = 'falling';
  else                        direction = 'stable';

  return {
    direction,
    slopePerDay:  Math.round(slopePerDay * 100) / 100,
    avg:          Math.round(avg),
    min,
    max,
    current,
    observations: n,
    firstDay:     history[0].day,
    lastDay:      history[n - 1].day,
    projectDaysOut,   // helper fn — stripped before JSON serialisation
  };
}

/**
 * Days from today until the first of alert.month_start (next occurrence).
 * This estimates when the trip departs so we can apply booking-window heuristics.
 */
function daysUntilDeparture(alert) {
  if (!alert.month_start) return null;
  const today   = new Date();
  const depYear = alert.month_start <= today.getMonth() + 1
    ? today.getFullYear() + 1
    : today.getFullYear();
  const dep = new Date(depYear, alert.month_start - 1, 1);
  return Math.ceil((dep - today) / 86_400_000);
}

/**
 * Classify how close we are to the ideal booking window.
 * Airlines price internationally: cheapest ~3–6 months out.
 * Domestically: cheapest ~6–8 weeks out.
 * We use a single conservative heuristic suited to international flights.
 */
function bookingWindowStatus(daysOut) {
  if (daysOut === null) return { status: 'unknown', label: null };
  if (daysOut > 270)    return { status: 'too_early',   label: 'Too early — prices may drop closer to 3–6 months out' };
  if (daysOut > 120)    return { status: 'approaching', label: 'Approaching the sweet spot (3–6 months before departure)' };
  if (daysOut > 42)     return { status: 'sweet_spot',  label: '✓ In the booking sweet spot (6 weeks – 4 months out)' };
  if (daysOut > 14)     return { status: 'late',        label: 'Late — prices typically rise this close to departure' };
  return                       { status: 'last_minute', label: 'Last-minute window — book now or risk no availability' };
}

/**
 * Generate a buy recommendation.
 *
 * @param {object|null} trend   result of computeTrend()
 * @param {object}      alert   DB alert row (includes book_by, threshold, month_start)
 * @returns {{
 *   action: string,
 *   message: string,
 *   detail: string|null,
 *   daysUntilDeadline: number|null,
 *   daysUntilDeparture: number|null,
 *   projectedAtDeadline: number|null,
 *   projectedSavings: number|null,
 *   bookingWindow: object,
 * }}
 */
export function generateAdvice(trend, alert) {
  // ── Deadline ────────────────────────────────────────────────────────────────
  let daysUntilDeadline = null;
  if (alert.book_by) {
    const deadline = new Date(alert.book_by + 'T00:00:00');
    const today    = new Date();
    today.setHours(0, 0, 0, 0);
    daysUntilDeadline = Math.ceil((deadline - today) / 86_400_000);
  }

  // ── Departure proximity ─────────────────────────────────────────────────────
  const depDays     = daysUntilDeparture(alert);
  const bookWin     = bookingWindowStatus(depDays);

  // ── Price projection to deadline ────────────────────────────────────────────
  let projectedAtDeadline = null;
  let projectedSavings    = null;
  if (trend && daysUntilDeadline !== null && daysUntilDeadline > 0) {
    // Days from last observation to deadline
    const daysSinceLast = Math.max(
      0,
      (Date.now() - new Date(trend.lastDay + 'T12:00:00').getTime()) / 86_400_000
    );
    projectedAtDeadline = Math.round(trend.current + trend.slopePerDay * (daysSinceLast + daysUntilDeadline));
    projectedSavings    = projectedAtDeadline - trend.current;
  }

  const base = { daysUntilDeadline, daysUntilDeparture: depDays, projectedAtDeadline, projectedSavings, bookingWindow: bookWin };

  // ── Rule 1: Deadline already passed or < 7 days ──────────────────────────────
  if (daysUntilDeadline !== null && daysUntilDeadline < 7) {
    const msg = daysUntilDeadline <= 0
      ? 'Your booking deadline has passed — act immediately if you still want this trip.'
      : `Only ${daysUntilDeadline} day${daysUntilDeadline === 1 ? '' : 's'} left on your deadline. Book now regardless of price.`;
    return { ...base, action: 'buy_now', message: msg, detail: null };
  }

  // ── No trend data yet ────────────────────────────────────────────────────────
  if (!trend) {
    if (daysUntilDeadline !== null && daysUntilDeadline < 14) {
      return { ...base, action: 'consider', detail: null,
        message: 'Deadline approaching but not enough price history yet — consider booking to be safe.' };
    }
    return { ...base, action: 'monitor', detail: null,
      message: 'Building price history — check back after a few more data points for trend analysis.' };
  }

  const { direction, slopePerDay, avg, min, current } = trend;
  const pctAboveMin = (current - min) / min;
  const pctVsAvg    = (current - avg) / avg;

  // Build projection detail line (shown beneath the main message)
  let projectionDetail = null;
  if (projectedAtDeadline !== null) {
    const diff = projectedSavings ?? 0;
    if (Math.abs(diff) >= 5) {
      projectionDetail = diff > 0
        ? `At the current trend, waiting until your deadline would cost ~$${Math.abs(diff)} more ($${projectedAtDeadline} projected).`
        : `At the current trend, prices could drop ~$${Math.abs(diff)} by your deadline ($${projectedAtDeadline} projected).`;
    }
  }

  // ── Rule 2: Within 5% of historical low ──────────────────────────────────────
  if (pctAboveMin <= 0.05) {
    return { ...base, action: 'buy_now', detail: projectionDetail,
      message: `$${current} is within 5% of the historical low ($${min}). This is a strong buy signal — prices rarely go lower.` };
  }

  // ── Rule 3: Rising + deadline < 30 days ──────────────────────────────────────
  if (direction === 'rising' && daysUntilDeadline !== null && daysUntilDeadline < 30) {
    return { ...base, action: 'buy_now', detail: projectionDetail,
      message: `Prices are rising +$${Math.abs(slopePerDay)}/day and you only have ${daysUntilDeadline} days until your deadline. Don't wait.` };
  }

  // ── Rule 4: Rising + in sweet spot booking window ─────────────────────────────
  if (direction === 'rising' && bookWin.status === 'sweet_spot') {
    return { ...base, action: 'buy_now', detail: projectionDetail,
      message: `Prices are rising and you're in the booking sweet spot. Waiting is likely to cost more.` };
  }

  // ── Rule 5: Below average >10% + deadline < 60 days ──────────────────────────
  if (pctVsAvg < -0.10 && daysUntilDeadline !== null && daysUntilDeadline < 60) {
    return { ...base, action: 'consider', detail: projectionDetail,
      message: `At $${current}, the price is ${Math.round(Math.abs(pctVsAvg) * 100)}% below the average you've seen ($${avg}). Good value with your deadline approaching.` };
  }

  // ── Rule 6: In sweet spot with decent price ───────────────────────────────────
  if (bookWin.status === 'sweet_spot' && pctVsAvg <= 0.05) {
    return { ...base, action: 'consider', detail: projectionDetail,
      message: `You're in the booking sweet spot (6 weeks – 4 months before departure) and the price is near average. Consider booking.` };
  }

  // ── Rule 7: Falling + time to wait ───────────────────────────────────────────
  if (direction === 'falling' && (daysUntilDeadline === null || daysUntilDeadline > 21) && bookWin.status !== 'late') {
    return { ...base, action: 'wait', detail: projectionDetail,
      message: `Prices are falling $${Math.abs(slopePerDay)}/day. You have time — hold off for a lower price.` };
  }

  // ── Rule 8: Above average + time to wait ─────────────────────────────────────
  if (pctVsAvg > 0.05 && (daysUntilDeadline === null || daysUntilDeadline > 14) && bookWin.status !== 'late') {
    return { ...base, action: 'wait', detail: projectionDetail,
      message: `$${current} is above the average you've seen ($${avg}). Hold off — it may come down.` };
  }

  // ── Rule 9: Late booking window ───────────────────────────────────────────────
  if (bookWin.status === 'late' || bookWin.status === 'last_minute') {
    return { ...base, action: 'buy_now', detail: projectionDetail,
      message: `You're close to departure — don't count on prices dropping further. Book now.` };
  }

  // ── Default: monitor ──────────────────────────────────────────────────────────
  return { ...base, action: 'monitor', detail: projectionDetail,
    message: `Prices are ${direction} around the historical average ($${avg}). No strong signal yet — keep watching.` };
}
