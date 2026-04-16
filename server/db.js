import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || join(__dirname, '..', 'data');

mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(join(DATA_DIR, 'yycflights.db'));

db.exec(`PRAGMA journal_mode = WAL`);
db.exec(`PRAGMA foreign_keys = ON`);

db.exec(`
  CREATE TABLE IF NOT EXISTS alerts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    destination  TEXT    NOT NULL,
    dest_label   TEXT    NOT NULL,
    month_start  INTEGER NOT NULL,
    month_end    INTEGER NOT NULL,
    threshold    REAL    NOT NULL,
    email        TEXT    NOT NULL,
    active       INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    last_checked TEXT
  );

  CREATE TABLE IF NOT EXISTS flight_results (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_id     INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    price        REAL    NOT NULL,
    currency     TEXT    NOT NULL DEFAULT 'CAD',
    departure_at TEXT    NOT NULL,
    return_at    TEXT,
    airline      TEXT,
    deep_link    TEXT,
    raw_json     TEXT,
    found_at     TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS notifications_sent (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_id         INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    flight_result_id INTEGER NOT NULL REFERENCES flight_results(id),
    sent_at          TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_results_alert ON flight_results(alert_id, found_at DESC);
  CREATE INDEX IF NOT EXISTS idx_alerts_active ON alerts(active);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS digest_tokens (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    email        TEXT    NOT NULL UNIQUE,
    token        TEXT    NOT NULL UNIQUE,
    unsubscribed INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

// ── Migrations (idempotent — safe on every startup) ───────────────────────────
try { db.exec(`ALTER TABLE alerts ADD COLUMN book_by   TEXT`);                             } catch { /* already exists */ }
try { db.exec(`ALTER TABLE alerts ADD COLUMN stops     INTEGER NOT NULL DEFAULT 0`);       } catch { /* already exists */ }
try { db.exec(`ALTER TABLE alerts ADD COLUMN trip_type TEXT    NOT NULL DEFAULT 'round'`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE alerts ADD COLUMN user_id   TEXT`);                             } catch { /* already exists */ }
try { db.exec(`ALTER TABLE alerts ADD COLUMN taxes_included INTEGER NOT NULL DEFAULT 1`); } catch { /* already exists */ }
// Feature 1 — flex date windows
try { db.exec(`ALTER TABLE alerts ADD COLUMN target_date TEXT`);                           } catch { /* already exists */ }
try { db.exec(`ALTER TABLE alerts ADD COLUMN flex_days   INTEGER NOT NULL DEFAULT 0`);     } catch { /* already exists */ }
// Feature 3 — Deal Watcher mode ('threshold' | 'deal')
try { db.exec(`ALTER TABLE alerts ADD COLUMN alert_mode TEXT NOT NULL DEFAULT 'threshold'`); } catch { /* already exists */ }

// Feature 4 — Explore baselines (popular YYC destinations precomputed weekly)
db.exec(`
  CREATE TABLE IF NOT EXISTS destination_baselines (
    iata          TEXT PRIMARY KEY,
    dest_label    TEXT NOT NULL,
    theme         TEXT NOT NULL,
    lowest_price  REAL,
    lowest_date   TEXT,
    airline       TEXT,
    deep_link     TEXT,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ── Alerts ────────────────────────────────────────────────────────────────────

// One query powers both per-user and scheduler listings — a shared SELECT
// avoids drift between the two (e.g. missing a column on one side).
const _LATEST_PRICE_SELECT = `
  SELECT a.*,
         (SELECT price    FROM flight_results WHERE alert_id = a.id ORDER BY found_at DESC LIMIT 1) AS latest_price,
         (SELECT found_at FROM flight_results WHERE alert_id = a.id ORDER BY found_at DESC LIMIT 1) AS latest_found_at,
         (SELECT MIN(price) FROM flight_results WHERE alert_id = a.id) AS best_price
  FROM alerts a
`;

export function listAlerts(userId) {
  return db.prepare(`
    ${_LATEST_PRICE_SELECT}
    WHERE a.user_id = ?
    ORDER BY a.active DESC, a.created_at DESC
  `).all(userId);
}

export function getAlert(id, userId = null) {
  if (userId) {
    return db.prepare('SELECT * FROM alerts WHERE id = ? AND user_id = ?').get(id, userId);
  }
  return db.prepare('SELECT * FROM alerts WHERE id = ?').get(id);
}

export function createAlert(data) {
  const stmt = db.prepare(`
    INSERT INTO alerts (
      destination, dest_label, month_start, month_end, threshold, email,
      book_by, stops, trip_type, user_id, taxes_included,
      target_date, flex_days, alert_mode
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    data.destination, data.dest_label, data.month_start,
    data.month_end, data.threshold ?? 0, data.email,
    data.book_by  ?? null,
    data.stops    ?? 0,
    data.trip_type ?? 'round',
    data.user_id  ?? null,
    data.taxes_included ?? 1,
    data.target_date ?? null,
    data.flex_days   ?? 0,
    data.alert_mode  ?? 'threshold'
  );
  return getAlert(Number(result.lastInsertRowid));
}

export function updateAlert(id, data) {
  const allowed = ['destination','dest_label','month_start','month_end','threshold','email','active','book_by','stops','trip_type','taxes_included','target_date','flex_days','alert_mode'];
  const fields  = Object.keys(data).filter(k => allowed.includes(k));
  if (!fields.length) return getAlert(id);
  const setClause = fields.map(f => `${f} = ?`).join(', ');
  const values    = fields.map(f => data[f]);
  db.prepare(`UPDATE alerts SET ${setClause} WHERE id = ?`).run(...values, id);
  return getAlert(id);
}

export function deleteAlert(id) {
  return db.prepare('DELETE FROM alerts WHERE id = ?').run(id);
}

export function touchAlertChecked(id) {
  db.prepare(`UPDATE alerts SET last_checked = datetime('now') WHERE id = ?`).run(id);
}

// ── Flight results ────────────────────────────────────────────────────────────

export function insertResult(data) {
  const stmt = db.prepare(`
    INSERT INTO flight_results (alert_id, price, currency, departure_at, return_at, airline, deep_link, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    data.alert_id, data.price, data.currency || 'CAD',
    data.departure_at, data.return_at ?? null, data.airline ?? null,
    data.deep_link ?? null, data.raw_json ?? null
  );
  return Number(result.lastInsertRowid);
}

export function getResults(alertId, limit = 50) {
  return db.prepare(`
    SELECT * FROM flight_results
    WHERE alert_id = ?
    ORDER BY found_at DESC
    LIMIT ?
  `).all(alertId, limit);
}

/**
 * Cheapest price per calendar day — used for trend analysis.
 * Returns [{day: 'YYYY-MM-DD', min_price: number}, ...] oldest-first.
 */
export function getPriceHistory(alertId) {
  return db.prepare(`
    SELECT
      substr(found_at, 1, 10) AS day,
      MIN(price)              AS min_price
    FROM flight_results
    WHERE alert_id = ?
    GROUP BY substr(found_at, 1, 10)
    ORDER BY day ASC
  `).all(alertId);
}

// Used by scheduler — fetches all non-expired active alerts regardless of user.
// Alerts past their book_by date are excluded here (cheap filter); the checker
// separately flips their active flag via pruneExpiredAlerts() below.
export function listAllActiveAlerts() {
  return db.prepare(`
    ${_LATEST_PRICE_SELECT}
    WHERE a.active = 1
      AND (a.book_by IS NULL OR a.book_by >= date('now'))
    ORDER BY a.created_at DESC
  `).all();
}

/**
 * Flip `active = 0` on any alert whose book_by deadline has passed.
 * Returns the number of rows archived. Idempotent & cheap.
 */
export function pruneExpiredAlerts() {
  const res = db.prepare(`
    UPDATE alerts
    SET    active = 0
    WHERE  active = 1
      AND  book_by IS NOT NULL
      AND  book_by < date('now')
  `).run();
  return res.changes ?? 0;
}

// ── Notification dedup ────────────────────────────────────────────────────────

export function wasNotifiedRecently(alertId) {
  const row = db.prepare(`
    SELECT 1 FROM notifications_sent
    WHERE alert_id = ? AND sent_at > datetime('now', '-24 hours')
    LIMIT 1
  `).get(alertId);
  return !!row;
}

export function recordNotification(alertId, flightResultId) {
  db.prepare(`
    INSERT INTO notifications_sent (alert_id, flight_result_id) VALUES (?, ?)
  `).run(alertId, flightResultId);
}

// ── Weekly digest ─────────────────────────────────────────────────────────────

/** Top N cheapest prices found in the past 7 days across all active alerts */
export function getWeeklyTopDeals(limit = 8) {
  return db.prepare(`
    SELECT
      MIN(fr.price)    AS price,
      fr.departure_at,
      fr.return_at,
      fr.airline,
      fr.deep_link,
      a.dest_label,
      a.destination
    FROM flight_results fr
    JOIN alerts a ON a.id = fr.alert_id
    WHERE fr.found_at > datetime('now', '-7 days')
      AND a.active = 1
    GROUP BY a.destination, date(fr.departure_at)
    ORDER BY price ASC
    LIMIT ?
  `).all(limit);
}

/** Distinct emails that should receive the digest (active alerts, not unsubscribed) */
export function getDigestRecipients() {
  return db.prepare(`
    SELECT DISTINCT a.email
    FROM alerts a
    WHERE a.active = 1
      AND a.email NOT IN (
        SELECT email FROM digest_tokens WHERE unsubscribed = 1
      )
  `).all();
}

/** Get or create an unsubscribe token for this email */
export function upsertDigestToken(email, token) {
  db.prepare(`
    INSERT INTO digest_tokens (email, token) VALUES (?, ?)
    ON CONFLICT(email) DO UPDATE SET token = excluded.token
  `).run(email, token);
}

/** Look up a token and return the row */
export function getDigestToken(token) {
  return db.prepare(`SELECT * FROM digest_tokens WHERE token = ?`).get(token);
}

/** Mark an email as unsubscribed */
export function unsubscribeDigest(email) {
  db.prepare(`
    UPDATE digest_tokens SET unsubscribed = 1 WHERE email = ?
  `).run(email);
}

// ── Deal Watcher ──────────────────────────────────────────────────────────────

/**
 * Compute the 10th-percentile historical price for an alert.
 * Returns null if fewer than `minSamples` daily-low observations exist yet.
 */
export function getAlertPriceFloor(alertId, minSamples = 7) {
  // Use one daily-low sample per day to avoid intraday noise
  const rows = db.prepare(`
    SELECT MIN(price) AS p
    FROM flight_results
    WHERE alert_id = ?
    GROUP BY substr(found_at, 1, 10)
    ORDER BY p ASC
  `).all(alertId).map(r => r.p);

  if (rows.length < minSamples) return null;
  // 10th-percentile index, 0-based. With 7 samples: ceil(0.7) - 1 = 0 → the
  // lowest observation IS the p10, which is the correct answer for tiny n.
  // With 30 samples: ceil(3) - 1 = 2 → the 3rd-lowest, as expected.
  const idx = Math.max(0, Math.ceil(rows.length * 0.10) - 1);
  return {
    p10:     Math.round(rows[idx]),
    min:     Math.round(rows[0]),
    median:  Math.round(rows[Math.floor(rows.length / 2)]),
    samples: rows.length,
  };
}

/**
 * Bulk-insert flight results inside a single transaction — a 10–50× speedup
 * over looping `insertResult` when SerpApi returns many offers for one alert.
 *
 * @param {number} alertId
 * @param {Array<Partial<{price, currency, departure_at, return_at, airline, deep_link, raw_json}>>} offers
 * @returns {Array<number>} inserted row IDs, same order as input.
 */
export function insertResultsBulk(alertId, offers) {
  if (!offers?.length) return [];
  const stmt = db.prepare(`
    INSERT INTO flight_results (alert_id, price, currency, departure_at, return_at, airline, deep_link, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const ids = [];
  const runTxn = db.prepare('BEGIN');
  const commit = db.prepare('COMMIT');
  const rollback = db.prepare('ROLLBACK');
  runTxn.run();
  try {
    for (const o of offers) {
      const r = stmt.run(
        alertId, o.price, o.currency || 'CAD',
        o.departure_at, o.return_at ?? null, o.airline ?? null,
        o.deep_link ?? null, o.raw_json ?? null,
      );
      ids.push(Number(r.lastInsertRowid));
    }
    commit.run();
  } catch (err) {
    try { rollback.run(); } catch { /* ignore */ }
    throw err;
  }
  return ids;
}

// ── Explore baselines ─────────────────────────────────────────────────────────

export function upsertBaseline({ iata, dest_label, theme, lowest_price, lowest_date, airline, deep_link }) {
  db.prepare(`
    INSERT INTO destination_baselines (iata, dest_label, theme, lowest_price, lowest_date, airline, deep_link, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(iata) DO UPDATE SET
      dest_label   = excluded.dest_label,
      theme        = excluded.theme,
      lowest_price = excluded.lowest_price,
      lowest_date  = excluded.lowest_date,
      airline      = excluded.airline,
      deep_link    = excluded.deep_link,
      updated_at   = datetime('now')
  `).run(iata, dest_label, theme, lowest_price, lowest_date, airline ?? null, deep_link ?? null);
}

export function listBaselines({ theme = null, maxPrice = null, month = null } = {}) {
  const clauses = ['lowest_price IS NOT NULL'];
  const params  = [];
  if (theme)    { clauses.push('theme = ?');       params.push(theme); }
  if (maxPrice) { clauses.push('lowest_price <= ?'); params.push(maxPrice); }
  if (month)    { clauses.push("CAST(substr(lowest_date, 6, 2) AS INTEGER) = ?"); params.push(month); }

  return db.prepare(`
    SELECT * FROM destination_baselines
    WHERE ${clauses.join(' AND ')}
    ORDER BY lowest_price ASC
  `).all(...params);
}

/** Active alerts + latest price for a specific email — for personal digest summary */
export function getAlertsForEmail(email) {
  return db.prepare(`
    ${_LATEST_PRICE_SELECT}
    WHERE a.active = 1 AND a.email = ?
    ORDER BY a.created_at DESC
  `).all(email);
}

export default db;
