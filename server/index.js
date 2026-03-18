import 'dotenv/config';
import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { startScheduler, getSchedulerStatus } from './scheduler.js';
import alertsRouter from './routes/alerts.js';
import flightsRouter from './routes/flights.js';
import destinationsRouter from './routes/destinations.js';
import digestRouter from './routes/digest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(join(__dirname, '..', 'public')));

// API routes
app.use('/api/alerts', alertsRouter);
app.use('/api/flights', flightsRouter);
app.use('/api/destinations', destinationsRouter);
app.use('/api/digest', digestRouter);

// Public config — safe to expose (publishable key only)
app.get('/api/config', (_req, res) => {
  res.json({
    clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY || '',
    authEnabled: !!process.env.CLERK_SECRET_KEY,
  });
});

app.get('/api/health', (_req, res) => {
  const { lastRun, isRunning } = getSchedulerStatus();
  res.json({
    ok: true,
    origin: process.env.ORIGIN || 'YYC',
    apiReady: !!process.env.SERPAPI_KEY,
    scheduler: { lastRun, isRunning },
  });
});

// SPA fallback — serve index.html for any non-API route
app.get('*', (_req, res) => {
  res.sendFile(join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`YYC Flights running at http://localhost:${PORT}`);
  startScheduler();
});
