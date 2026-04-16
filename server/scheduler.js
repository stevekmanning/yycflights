import cron from 'node-cron';
import { runAllChecks } from './services/flightChecker.js';
import { sendWeeklyDigest } from './services/digest.js';
import { runExploreSweep } from './services/explore.js';
import db, { pruneExpiredAlerts } from './db.js';

let lastRun = null;
let isRunning = false;

/**
 * If the Explore baselines are older than 10 days (e.g. the app was down
 * during last Monday's cron, or the first-ever boot), run a catch-up sweep
 * in the background so users aren't staring at an empty Explore tab.
 */
function maybeRunCatchupSweep() {
  try {
    const row = db.prepare(`
      SELECT MAX(updated_at) AS latest FROM destination_baselines
    `).get();
    const tooOld = !row?.latest || (Date.now() - new Date(row.latest).getTime()) > 10 * 86_400_000;
    if (tooOld && process.env.SERPAPI_KEY) {
      console.log('[scheduler] Explore baselines stale/empty — running catch-up sweep in background');
      runExploreSweep().catch(err => console.error('[scheduler] Catch-up sweep error:', err.message));
    }
  } catch (err) {
    console.error('[scheduler] Catch-up sweep check failed:', err.message);
  }
}

export function startScheduler() {
  const schedule = process.env.CRON_SCHEDULE || '0 0 */2 * *';

  if (!cron.validate(schedule)) {
    console.error(`[scheduler] Invalid cron schedule: "${schedule}"`);
    return;
  }

  cron.schedule(schedule, async () => {
    if (isRunning) {
      console.log('[scheduler] Previous run still in progress, skipping');
      return;
    }
    await runChecks();
  });

  console.log(`[scheduler] Started — running on schedule: ${schedule}`);

  // One-shot: archive any already-expired alerts so they don't appear active.
  try {
    const archived = pruneExpiredAlerts();
    if (archived > 0) console.log(`[scheduler] Archived ${archived} already-expired alert(s) at startup`);
  } catch (err) {
    console.error('[scheduler] Expired-prune error:', err.message);
  }

  // If baselines are stale / missing, kick off a background sweep.
  maybeRunCatchupSweep();

  // Weekly digest — Sunday 15:00 UTC (9am MDT)
  cron.schedule('0 15 * * 0', async () => {
    console.log('[scheduler] Sending weekly digest…');
    try {
      const result = await sendWeeklyDigest();
      console.log(`[scheduler] Digest sent — ${result.sent} emails`);
    } catch (err) {
      console.error('[scheduler] Digest error:', err.message);
    }
  });

  // Weekly Explore sweep — Monday 09:00 UTC (pre-workday, quiet hour)
  const exploreSchedule = process.env.EXPLORE_CRON_SCHEDULE || '0 9 * * 1';
  cron.schedule(exploreSchedule, async () => {
    console.log('[scheduler] Running Explore sweep…');
    try {
      const result = await runExploreSweep();
      console.log(`[scheduler] Explore sweep — ${result.ok} ok, ${result.fail} failed`);
    } catch (err) {
      console.error('[scheduler] Explore sweep error:', err.message);
    }
  });
}

async function runChecks() {
  isRunning = true;
  lastRun = new Date().toISOString();
  console.log(`[scheduler] Running scheduled flight check at ${lastRun}`);
  try {
    const summary = await runAllChecks();
    console.log(`[scheduler] Done — checked ${summary.checked}, alerts sent ${summary.alerted}`);
  } catch (err) {
    console.error('[scheduler] Error during scheduled run:', err.message);
  } finally {
    isRunning = false;
  }
}

export function getSchedulerStatus() {
  return { lastRun, isRunning };
}

// Allow manual trigger from API
export { runChecks };
