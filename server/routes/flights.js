import { Router } from 'express';
import { getResults, getAlert } from '../db.js';
import { searchFlights } from '../services/flights.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// All flight routes require authentication
router.use(requireAuth);

// GET /api/flights/search?dest=YVR&monthStart=6&monthEnd=8[&targetDate=YYYY-MM-DD&flexDays=3]
router.get('/search', async (req, res) => {
  const { dest, monthStart, monthEnd, yearStart, yearEnd, stops, tripType, targetDate, flexDays } = req.query;
  if (!dest) return res.status(400).json({ error: 'dest is required' });

  try {
    const { results, insights } = await searchFlights({
      destination: dest.toUpperCase(),
      monthStart:  Number(monthStart) || 1,
      monthEnd:    Number(monthEnd)   || 12,
      yearStart:   yearStart ? Number(yearStart) : null,
      yearEnd:     yearEnd   ? Number(yearEnd)   : null,
      targetDate:  targetDate || null,
      flexDays:    Number(flexDays) || 0,
      stops:       Number(stops)      || 0,
      tripType:    tripType           || 'round',
    });
    res.json({ results, insights });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET /api/flights/calendar?dest=YVR&year=2026&month=6&tripType=round&stops=0
// Returns cheapest price per day for one calendar month.
router.get('/calendar', async (req, res) => {
  const { dest, year, month, stops, tripType } = req.query;
  if (!dest || !year || !month) {
    return res.status(400).json({ error: 'dest, year, month are required' });
  }
  const y = Number(year), m = Number(month);
  if (!y || !m || m < 1 || m > 12) return res.status(400).json({ error: 'invalid year/month' });

  // Build every date of the month (future-only) — cap at ~3 samples per week to limit cost
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const daysInMonth = new Date(y, m, 0).getDate();
  const pad = n => String(n).padStart(2, '0');
  const sampleDates = [];
  for (let d = 1; d <= daysInMonth; d++) {
    // Sample every other day to halve cost (still 15 points per month)
    if (d % 2 !== 0 && d !== daysInMonth) continue;
    const iso = `${y}-${pad(m)}-${pad(d)}`;
    if (new Date(iso + 'T12:00:00') >= today) sampleDates.push(iso);
  }

  try {
    const { results } = await searchFlights({
      destination:    dest.toUpperCase(),
      departureDates: sampleDates,
      stops:          Number(stops) || 0,
      tripType:       tripType || 'round',
    });

    // Roll up cheapest price per day
    const byDay = {};
    for (const r of results) {
      const day = (r.departure_at || '').slice(0, 10);
      if (!day) continue;
      if (!byDay[day] || r.price < byDay[day].price) byDay[day] = r;
    }
    res.json({ year: y, month: m, byDay });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET /api/flights/results/:alertId
router.get('/results/:alertId', (req, res) => {
  const alertId = Number(req.params.alertId);
  // Verify the alert belongs to this user
  if (!getAlert(alertId, req.userId)) {
    return res.status(404).json({ error: 'Alert not found' });
  }
  const limit = Number(req.query.limit) || 50;
  res.json(getResults(alertId, limit));
});

export default router;
