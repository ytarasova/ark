/**
 * Multi-instance coordination via SQLite.
 * Uses a heartbeat table to detect and coordinate concurrent instances.
 */

import type { AppContext } from "../app.js";
import { logWarn } from "../observability/structured-log.js";

const HEARTBEAT_INTERVAL_MS = 2000;
const STALE_THRESHOLD_MS = 10000;

function isShutdownRace(msg: string): boolean {
  return msg.includes("closed") || msg.includes("not open");
}

/** Register this instance and start heartbeat. Returns cleanup function. */
export function registerInstance(app: AppContext, instanceId: string): { stop: () => void; isPrimary: () => boolean } {
  const db = app.db;

  db.exec(`
    CREATE TABLE IF NOT EXISTS instance_heartbeat (
      id TEXT PRIMARY KEY,
      pid INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      last_heartbeat TEXT NOT NULL
    )
  `);

  cleanStaleInstances(app);

  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT OR REPLACE INTO instance_heartbeat (id, pid, started_at, last_heartbeat)
    VALUES (?, ?, ?, ?)
  `,
  ).run(instanceId, process.pid, now, now);

  const interval = setInterval(() => {
    try {
      db.prepare("UPDATE instance_heartbeat SET last_heartbeat = ? WHERE id = ?").run(
        new Date().toISOString(),
        instanceId,
      );
      cleanStaleInstances(app);
    } catch (e: any) {
      // The DB is normally closed during shutdown between the interval firing and stop() running.
      // Tolerate that specific case but surface anything else so a heartbeat stall is visible.
      const msg = String(e?.message ?? e);
      if (!isShutdownRace(msg)) {
        logWarn("session", `instance-lock: heartbeat update failed: ${msg}`);
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  return {
    stop: () => {
      clearInterval(interval);
      try {
        db.prepare("DELETE FROM instance_heartbeat WHERE id = ?").run(instanceId);
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (!isShutdownRace(msg)) {
          logWarn("session", `instance-lock: heartbeat delete failed: ${msg}`);
        }
      }
    },
    isPrimary: () => {
      try {
        const first = db.prepare("SELECT id FROM instance_heartbeat ORDER BY started_at ASC LIMIT 1").get() as
          | { id: string }
          | undefined;
        return first?.id === instanceId;
      } catch (e: any) {
        logWarn("session", `instance-lock: isPrimary check failed, assuming primary: ${String(e?.message ?? e)}`);
        return true;
      }
    },
  };
}

/** Remove instances that haven't sent a heartbeat recently. */
function cleanStaleInstances(app: AppContext): void {
  try {
    const db = app.db;
    const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();
    db.prepare("DELETE FROM instance_heartbeat WHERE last_heartbeat < ?").run(cutoff);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (!isShutdownRace(msg)) {
      logWarn("session", `instance-lock: stale cleanup failed: ${msg}`);
    }
  }
}

/** Get count of active instances. */
export function activeInstanceCount(app: AppContext): number {
  try {
    const db = app.db;
    db.exec(`CREATE TABLE IF NOT EXISTS instance_heartbeat (
      id TEXT PRIMARY KEY, pid INTEGER NOT NULL,
      started_at TEXT NOT NULL, last_heartbeat TEXT NOT NULL
    )`);
    cleanStaleInstances(app);
    const row = db.prepare("SELECT COUNT(*) as count FROM instance_heartbeat").get() as { count: number };
    return row.count;
  } catch (e: any) {
    logWarn("session", `instance-lock: activeInstanceCount failed: ${String(e?.message ?? e)}`);
    return 0;
  }
}
