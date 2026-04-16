import { Router } from 'express';
import { listBaselines } from '../db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { runExploreSweep } from '../services/explore.js';

const router = Router();
router.use(requireAuth);

// GET /api/explore?theme=beach&maxPrice=900&month=6
router.get('/', (req, res) => {
  const { theme, maxPrice, month } = req.query;
  const results = listBaselines({
    theme:    theme || null,
    maxPrice: maxPrice ? Number(maxPrice) : null,
    month:    month ? Number(month) : null,
  });
  res.json({ results });
});

// POST /api/explore/sweep — admin-gated: burns SerpApi quota (37 dests × 6 months).
router.post('/sweep', requireAdmin, async (_req, res) => {
  try {
    const summary = await runExploreSweep();
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
