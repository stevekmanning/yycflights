import 'dotenv/config';
import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { startScheduler, getSchedulerStatus } from './scheduler.js';
import alertsRouter from './routes/alerts.js';
import flightsRouter from './routes/flights.js';
import destinationsRouter from './routes/destinations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(join(__dirname, '..', 'public')));

// API routes
app.use('/api/alerts', alertsRouter);
app.use('/api/flights', flightsRouter);
app.use('/api/destinations', destinationsRouter);

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
