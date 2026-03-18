import { Router } from 'express';
import { z } from 'zod';
import { listAlerts, getAlert, createAlert, updateAlert, deleteAlert, getPriceHistory } from '../db.js';
import { checkOneAlert } from '../services/flightChecker.js';
import { computeTrend, generateAdvice } from '../services/advisor.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// All alert routes require authentication
router.use(requireAuth);

const AlertSchema = z.object({
  destination: z.string().length(3).toUpperCase(),
  dest_label:  z.string().min(1),
  month_start: z.number().int().min(1).max(12),
  month_end:   z.number().int().min(1).max(12),
  threshold:   z.number().positive(),
  email:       z.string().email(),
  book_by:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  stops:       z.number().int().min(0).max(3).optional().default(0),
  trip_type:   z.enum(['round', 'oneway']).optional().default('round'),
});

// GET /api/alerts
router.get('/', (req, res) => {
  res.json(listAlerts(req.userId));
});

// POST /api/alerts
router.post('/', (req, res) => {
  const existing = listAlerts(req.userId);
  if (existing.length >= 5) {
    return res.status(409).json({ error: 'You can have at most 5 active alerts. Delete one to add a new one.' });
  }

  const parsed = AlertSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const alert = createAlert({ ...parsed.data, user_id: req.userId });
  res.status(201).json(alert);
});

// PATCH /api/alerts/:id
router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!getAlert(id, req.userId)) return res.status(404).json({ error: 'Alert not found' });

  const parsed = AlertSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  res.json(updateAlert(id, parsed.data));
});

// DELETE /api/alerts/:id
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!getAlert(id, req.userId)) return res.status(404).json({ error: 'Alert not found' });
  deleteAlert(id);
  res.json({ ok: true });
});

// POST /api/alerts/:id/check  — manual trigger
router.post('/:id/check', async (req, res) => {
  const id    = Number(req.params.id);
  const alert = getAlert(id, req.userId);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });

  try {
    const result = await checkOneAlert(alert);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET /api/alerts/:id/analysis  — trend + advice
router.get('/:id/analysis', (req, res) => {
  const id    = Number(req.params.id);
  const alert = getAlert(id, req.userId);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });

  const history = getPriceHistory(id);
  const trend   = computeTrend(history);
  const advice  = generateAdvice(trend, alert);

  // Strip non-serialisable helper fn before sending
  const trendJson = trend ? (({ projectDaysOut, ...rest }) => rest)(trend) : null;

  res.json({ alert, trend: trendJson, advice, history });
});

export default router;
