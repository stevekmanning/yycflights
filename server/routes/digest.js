import { Router } from 'express';
import { getDigestToken, unsubscribeDigest } from '../db.js';
import { sendWeeklyDigest } from '../services/digest.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

const router = Router();

// GET /api/digest/unsubscribe?token=xxx  — public, no auth needed
router.get('/unsubscribe', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Missing token');

  const row = getDigestToken(token);
  if (!row) return res.status(404).send('Invalid or expired unsubscribe link');

  if (row.unsubscribed) {
    return res.send(unsubPage('You\'re already unsubscribed from the weekly digest.'));
  }

  unsubscribeDigest(row.email);
  res.send(unsubPage('You\'ve been unsubscribed from the weekly digest. You\'ll still receive individual price alerts.'));
});

// POST /api/digest/send  — admin-only manual trigger (mass email fan-out)
router.post('/send', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await sendWeeklyDigest();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function unsubPage(message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>YYC Flights — Unsubscribe</title>
  <style>
    body { margin:0; background:#0f1117; color:#e2e8f0;
           font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
           display:flex; align-items:center; justify-content:center; min-height:100vh; }
    .box { text-align:center; padding:40px 24px; max-width:400px; }
    .plane { font-size:2.5rem; margin-bottom:16px; }
    h1 { font-size:1.2rem; margin:0 0 12px; }
    p  { color:#64748b; font-size:.9rem; margin:0 0 24px; line-height:1.6; }
    a  { color:#3b82f6; text-decoration:none; font-weight:600; }
  </style>
</head>
<body>
  <div class="box">
    <div class="plane">✈</div>
    <h1>YYC Flights</h1>
    <p>${message}</p>
    <a href="/">← Back to YYC Flights</a>
  </div>
</body>
</html>`;
}

export default router;
