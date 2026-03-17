import { Router } from 'express';
import { searchDestinations } from '../services/flights.js';

const router = Router();

// GET /api/destinations/search?q=Vancouver
router.get('/search', async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json([]);

  try {
    const results = await searchDestinations(q);
    res.json(results);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

export default router;
