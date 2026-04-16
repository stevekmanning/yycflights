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
 * Days from today until the alert's likely departure.
 * Priority: explicit target_date > first day of month_start (next future occurrence).
 */
function daysUntilDeparture(alert) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Explicit target date takes precedence — cheapest and most accurate signal.
  if (alert.target_date) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(alert.target_date);
    if (m) {
      const dep = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return Math.ceil((dep - today) / 86_400_000);
    }
  }

  if (!alert.month_start) return null;

  // Use year_start when provided (multi-year alerts). Otherwise, pick the next
  // future occurrence of month_start: if we are AFTER that month in the current
  // year, roll to next year; otherwise this year still has it ahead of us.
  const currentMonth = today.getMonth() + 1;
  const depYear = alert.year_start
    ? alert.year_start
    : (alert.month_start < currentMonth ? today.getFullYear() + 1 : today.getFullYear());

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

/**
 * Build plain-English "why this price?" bullets for the advisory panel.
 * Each bullet: { icon, text, tone: 'good' | 'warn' | 'neutral' }
 *
 * @param {object} args  { alert, trend, advice, floor, latestResults }
 */
export function generateReasons({ alert, trend, advice, floor, latestResults }) {
  const reasons = [];

  // 1. Percentile / floor comparison
  if (trend && floor) {
    const current = trend.current;
    const pctVsP10 = ((current - floor.p10) / floor.p10) * 100;
    if (current <= floor.p10 * 0.95) {
      reasons.push({
        icon: '🔥',
        tone: 'good',
        text: `$${current} is ${Math.round(Math.abs(pctVsP10))}% below the typical low of $${floor.p10} — exceptional deal.`,
      });
    } else if (current <= floor.p10) {
      reasons.push({
        icon: '🟢',
        tone: 'good',
        text: `$${current} is in the bottom 10% of ${floor.samples} daily-low observations (typical low: $${floor.p10}).`,
      });
    } else if (current >= floor.median * 1.15) {
      reasons.push({
        icon: '🔴',
        tone: 'warn',
        text: `$${current} is ~${Math.round(((current - floor.median) / floor.median) * 100)}% above the median ($${floor.median}) — on the high side.`,
      });
    } else {
      reasons.push({
        icon: '🟡',
        tone: 'neutral',
        text: `$${current} is around typical for this route (median: $${floor.median}, low: $${floor.min}).`,
      });
    }
  } else if (trend && trend.observations >= 2) {
    reasons.push({
      icon: '📊',
      tone: 'neutral',
      text: `Based on ${trend.observations} days of data — low $${trend.min}, avg $${trend.avg}, high $${trend.max}.`,
    });
  }

  // 2. Trend direction
  if (trend && trend.observations >= 3) {
    if (trend.direction === 'falling') {
      reasons.push({
        icon: '▼',
        tone: 'good',
        text: `Prices are falling ~$${Math.abs(trend.slopePerDay)}/day over recent checks.`,
      });
    } else if (trend.direction === 'rising') {
      reasons.push({
        icon: '▲',
        tone: 'warn',
        text: `Prices are rising ~$${Math.abs(trend.slopePerDay)}/day — waiting may cost more.`,
      });
    }
  }

  // 3. Booking window / deadline pressure
  if (advice.bookingWindow?.status === 'sweet_spot') {
    reasons.push({
      icon: '🎯',
      tone: 'good',
      text: 'You are in the sweet spot — 6 weeks to 4 months before departure, when fares are typically cheapest.',
    });
  } else if (advice.bookingWindow?.status === 'too_early') {
    reasons.push({
      icon: '⏳',
      tone: 'neutral',
      text: 'Still early — international fares usually drop 3–6 months before departure.',
    });
  } else if (advice.bookingWindow?.status === 'late' || advice.bookingWindow?.status === 'last_minute') {
    reasons.push({
      icon: '⚠️',
      tone: 'warn',
      text: 'Close to departure — last-minute fares typically rise sharply from here.',
    });
  }

  if (advice.daysUntilDeadline !== null && advice.daysUntilDeadline <= 14 && advice.daysUntilDeadline >= 0) {
    reasons.push({
      icon: '⏰',
      tone: 'warn',
      text: `Your book-by deadline is in ${advice.daysUntilDeadline} day${advice.daysUntilDeadline === 1 ? '' : 's'}.`,
    });
  }

  // 4. Airline premium (if the cheapest recent result is much cheaper than the user's preferred-looking carriers)
  if (latestResults?.length >= 3) {
    const byAirline = {};
    for (const r of latestResults) {
      if (!r.airline) continue;
      if (!byAirline[r.airline] || r.price < byAirline[r.airline]) byAirline[r.airline] = r.price;
    }
    const carriers = Object.entries(byAirline).sort((a, b) => a[1] - b[1]);
    if (carriers.length >= 2) {
      const [cheapest, cheapestPrice] = carriers[0];
      const [secondBest, secondPrice] = carriers[1];
      const delta = Math.round(secondPrice - cheapestPrice);
      if (delta >= 40) {
        reasons.push({
          icon: '✈️',
          tone: 'neutral',
          text: `${cheapest} is $${delta} cheaper than ${secondBest} on this route.`,
        });
      }
    }
  }

  // 5. Projection at deadline
  if (advice.projectedAtDeadline !== null && Math.abs(advice.projectedSavings ?? 0) >= 10) {
    const delta = advice.projectedSavings;
    reasons.push({
      icon: delta > 0 ? '📈' : '📉',
      tone: delta > 0 ? 'warn' : 'good',
      text: delta > 0
        ? `At current trend, waiting to your deadline could cost ~$${delta} more (~$${advice.projectedAtDeadline} projected).`
        : `At current trend, prices could drop ~$${Math.abs(delta)} by your deadline (~$${advice.projectedAtDeadline} projected).`,
    });
  }

  // 6. Alert mode context (Deal Watcher)
  if (alert.alert_mode === 'deal' && floor) {
    reasons.push({
      icon: '👀',
      tone: 'neutral',
      text: `Deal Watcher is active — you'll be emailed when price drops ≥5% below the typical low ($${floor.p10}).`,
    });
  } else if (alert.alert_mode === 'deal' && !floor) {
    reasons.push({
      icon: '📚',
      tone: 'neutral',
      text: 'Deal Watcher is learning — a few more days of price checks needed before it can spot anomalies.',
    });
  }

  return reasons;
}
