/**
 * Multi-instance coordination via SQLite.
 * Uses a heartbeat table to detect and coordinate concurrent instances.
 */

import type { AppContext } from "../app.js";

const HEARTBEAT_INTERVAL_MS = 2000;
const STALE_THRESHOLD_MS = 10000;

/** Register this instance and start heartbeat. Returns cleanup function. */
export function registerInstance(app: AppContext, instanceId: string): { stop: () => void; isPrimary: () => boolean } {
  const db = app.db;

  // Create heartbeat table if needed
  db.exec(`
    CREATE TABLE IF NOT EXISTS instance_heartbeat (
      id TEXT PRIMARY KEY,
      pid INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      last_heartbeat TEXT NOT NULL
    )
  `);

  // Clean stale instances
  cleanStaleInstances(app);

  // Register
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO instance_heartbeat (id, pid, started_at, last_heartbeat)
    VALUES (?, ?, ?, ?)
  `).run(instanceId, process.pid, now, now);

  // Start heartbeat
  const interval = setInterval(() => {
    try {
      db.prepare("UPDATE instance_heartbeat SET last_heartbeat = ? WHERE id = ?")
        .run(new Date().toISOString(), instanceId);
      cleanStaleInstances(app);
    } catch { /* DB may be closed */ }
  }, HEARTBEAT_INTERVAL_MS);

  return {
    stop: () => {
      clearInterval(interval);
      try {
        db.prepare("DELETE FROM instance_heartbeat WHERE id = ?").run(instanceId);
      } catch { /* ignore */ }
    },
    isPrimary: () => {
      try {
        const first = db.prepare(
          "SELECT id FROM instance_heartbeat ORDER BY started_at ASC LIMIT 1"
        ).get() as { id: string } | undefined;
        return first?.id === instanceId;
      } catch { return true; }
    },
  };
}

/** Remove instances that haven't sent a heartbeat recently. */
function cleanStaleInstances(app: AppContext): void {
  try {
    const db = app.db;
    const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();
    db.prepare("DELETE FROM instance_heartbeat WHERE last_heartbeat < ?").run(cutoff);
  } catch { /* ignore */ }
}

/** Get count of active instances. */
export function activeInstanceCount(app: AppContext): number {
  try {
    const db = app.db;
    // Ensure table exists
    db.exec(`CREATE TABLE IF NOT EXISTS instance_heartbeat (
      id TEXT PRIMARY KEY, pid INTEGER NOT NULL,
      started_at TEXT NOT NULL, last_heartbeat TEXT NOT NULL
    )`);
    cleanStaleInstances(app);
    const row = db.prepare("SELECT COUNT(*) as count FROM instance_heartbeat").get() as { count: number };
    return row.count;
  } catch { return 0; }
}
