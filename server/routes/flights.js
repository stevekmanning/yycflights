import { Router } from 'express';
import { getResults, getCheapestOverall, getAlert } from '../db.js';
import { searchFlights } from '../services/flights.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// All flight routes require authentication
router.use(requireAuth);

// GET /api/flights/search?dest=YVR&monthStart=6&monthEnd=8
router.get('/search', async (req, res) => {
  const { dest, monthStart, monthEnd, stops, tripType } = req.query;
  if (!dest) return res.status(400).json({ error: 'dest is required' });

  try {
    const results = await searchFlights({
      destination: dest.toUpperCase(),
      monthStart:  Number(monthStart) || 1,
      monthEnd:    Number(monthEnd)   || 12,
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

// GET /api/flights/cheapest
router.get('/cheapest', (req, res) => {
  res.json(getCheapestOverall(req.userId) || null);
});

export default router;
