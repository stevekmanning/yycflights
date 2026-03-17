import { Router } from 'express';
import { getResults, getCheapestOverall } from '../db.js';
import { searchFlights } from '../services/flights.js';

const router = Router();

// GET /api/flights/search?dest=YVR&monthStart=6&monthEnd=8
router.get('/search', async (req, res) => {
  const { dest, monthStart, monthEnd } = req.query;
  if (!dest) return res.status(400).json({ error: 'dest is required' });

  try {
    const results = await searchFlights({
      destination: dest.toUpperCase(),
      monthStart: Number(monthStart) || 1,
      monthEnd:   Number(monthEnd)   || 12,
    });
    res.json(results);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET /api/flights/results/:alertId
router.get('/results/:alertId', (req, res) => {
  const alertId = Number(req.params.alertId);
  const limit = Number(req.query.limit) || 50;
  res.json(getResults(alertId, limit));
});

// GET /api/flights/cheapest
router.get('/cheapest', (_req, res) => {
  res.json(getCheapestOverall() || null);
});

export default router;
