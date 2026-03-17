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

// ── Migrations (idempotent — safe on every startup) ───────────────────────────
try { db.exec(`ALTER TABLE alerts ADD COLUMN book_by   TEXT`);                          } catch { /* already exists */ }
try { db.exec(`ALTER TABLE alerts ADD COLUMN stops     INTEGER NOT NULL DEFAULT 0`);    } catch { /* already exists */ }
try { db.exec(`ALTER TABLE alerts ADD COLUMN trip_type TEXT    NOT NULL DEFAULT 'round'`); } catch { /* already exists */ }

// ── Alerts ────────────────────────────────────────────────────────────────────

export function listAlerts() {
  return db.prepare(`
    SELECT a.*,
           (SELECT price    FROM flight_results WHERE alert_id = a.id ORDER BY found_at DESC LIMIT 1) AS latest_price,
           (SELECT found_at FROM flight_results WHERE alert_id = a.id ORDER BY found_at DESC LIMIT 1) AS latest_found_at,
           (SELECT MIN(price) FROM flight_results WHERE alert_id = a.id) AS best_price
    FROM alerts a
    ORDER BY a.created_at DESC
  `).all();
}

export function getAlert(id) {
  return db.prepare('SELECT * FROM alerts WHERE id = ?').get(id);
}

export function createAlert(data) {
  const stmt = db.prepare(`
    INSERT INTO alerts (destination, dest_label, month_start, month_end, threshold, email, book_by, stops, trip_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    data.destination, data.dest_label, data.month_start,
    data.month_end, data.threshold, data.email,
    data.book_by ?? null,
    data.stops    ?? 0,
    data.trip_type ?? 'round'
  );
  return getAlert(Number(result.lastInsertRowid));
}

export function updateAlert(id, data) {
  const allowed = ['destination','dest_label','month_start','month_end','threshold','email','active','book_by','stops','trip_type'];
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

export function getCheapestOverall() {
  return db.prepare(`
    SELECT fr.*, a.destination, a.dest_label, a.threshold
    FROM flight_results fr
    JOIN alerts a ON a.id = fr.alert_id
    WHERE a.active = 1
    ORDER BY fr.price ASC
    LIMIT 1
  `).get();
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

export default db;
