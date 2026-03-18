import cron from 'node-cron';
import { runAllChecks } from './services/flightChecker.js';
import { sendWeeklyDigest } from './services/digest.js';

let lastRun = null;
let isRunning = false;

export function startScheduler() {
  const schedule = process.env.CRON_SCHEDULE || '0 */6 * * *';

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
