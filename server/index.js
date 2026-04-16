import 'dotenv/config';
import express from 'express';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { startScheduler, getSchedulerStatus } from './scheduler.js';
import alertsRouter from './routes/alerts.js';
import flightsRouter from './routes/flights.js';
import destinationsRouter from './routes/destinations.js';
import digestRouter from './routes/digest.js';
import exploreRouter from './routes/explore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3000;

// ── Derive Clerk Frontend API URL from publishable key ────────────────────────
// pk_test_BASE64$ → base64 decode → "domain.clerk.accounts.dev$"
function clerkFrontendApi(pk) {
  if (!pk) return '';
  const b64 = pk.replace(/^pk_(test|live)_/, '');
  return Buffer.from(b64, 'base64').toString('utf8').replace(/\$$/, '');
}

// ── Pre-render index.html with Clerk script injected ─────────────────────────
// Baking the script tag into the HTML lets the browser start downloading
// Clerk in parallel with everything else — no JS round-trip needed.
function buildIndexHtml() {
  const pk          = process.env.CLERK_PUBLISHABLE_KEY || '';
  const frontendApi = clerkFrontendApi(pk);
  const clerkScript = pk
    ? `<script async crossorigin="anonymous"
         data-clerk-publishable-key="${pk}"
         src="https://${frontendApi}/npm/@clerk/clerk-js@5/dist/clerk.browser.js">
       </script>`
    : '';

  const template = readFileSync(join(__dirname, '..', 'public', 'index.html'), 'utf8');
  return template.replace('<!-- CLERK_SCRIPT -->', clerkScript);
}

const indexHtml = buildIndexHtml();

app.use(express.json());
// index: false → let our catch-all serve the Clerk-injected index.html
app.use(express.static(join(__dirname, '..', 'public'), { index: false }));

// API routes
app.use('/api/alerts',       alertsRouter);
app.use('/api/flights',      flightsRouter);
app.use('/api/destinations', destinationsRouter);
app.use('/api/digest',       digestRouter);
app.use('/api/explore',      exploreRouter);

app.get('/api/health', (_req, res) => {
  const { lastRun, isRunning } = getSchedulerStatus();
  res.json({
    ok: true,
    origin:    process.env.ORIGIN || 'YYC',
    apiReady:  !!process.env.SERPAPI_KEY,
    authReady: !!process.env.CLERK_SECRET_KEY,
    scheduler: { lastRun, isRunning },
  });
});

// SPA fallback — serve pre-rendered HTML for every non-API route
app.get('*', (_req, res) => {
  res.type('html').send(indexHtml);
});

app.listen(PORT, () => {
  console.log(`YYC Flights running at http://localhost:${PORT}`);
  startScheduler();
});
