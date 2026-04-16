import { Router } from 'express';
import { getResults, getCheapestOverall, getAlert } from '../db.js';
import { searchFlights, fetchPriceInsights } from '../services/flights.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// All flight routes require authentication
router.use(requireAuth);

// GET /api/flights/search?dest=YVR&monthStart=6&monthEnd=8
router.get('/search', async (req, res) => {
  const { dest, monthStart, monthEnd, yearStart, yearEnd, stops, tripType } = req.query;
  if (!dest) return res.status(400).json({ error: 'dest is required' });

  try {
    const results = await searchFlights({
      destination: dest.toUpperCase(),
      monthStart:  Number(monthStart) || 1,
      monthEnd:    Number(monthEnd)   || 12,
      yearStart:   yearStart ? Number(yearStart) : null,
      yearEnd:     yearEnd   ? Number(yearEnd)   : null,
      stops:       Number(stops)      || 0,
      tripType:    tripType           || 'round',
    });
    res.json(results);
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

// GET /api/flights/insights?dest=YVR&date=2026-06-02&tripType=round
// Returns Google Flights price_insights for a specific route/date (60-day history, price level, typical range)
router.get('/insights', async (req, res) => {
  const { dest, date, tripType } = req.query;
  if (!dest || !date) return res.status(400).json({ error: 'dest and date required' });
  try {
    const insights = await fetchPriceInsights({ destination: dest.toUpperCase(), date, tripType: tripType || 'round' });
    res.json(insights || {});
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET /api/flights/cheapest
router.get('/cheapest', (req, res) => {
  res.json(getCheapestOverall(req.userId) || null);
});

export default router;
