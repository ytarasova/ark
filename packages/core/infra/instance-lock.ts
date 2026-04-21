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
export async function registerInstance(
  app: AppContext,
  instanceId: string,
): Promise<{ stop: () => void; isPrimary: () => Promise<boolean> }> {
  const db = app.db;

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS instance_heartbeat (
        id TEXT PRIMARY KEY,
        pid INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        last_heartbeat TEXT NOT NULL
      )`,
    )
    .run();

  await cleanStaleInstances(app);

  const now = new Date().toISOString();
  await db
    .prepare(`INSERT OR REPLACE INTO instance_heartbeat (id, pid, started_at, last_heartbeat) VALUES (?, ?, ?, ?)`)
    .run(instanceId, process.pid, now, now);

  const interval = setInterval(async () => {
    try {
      await db
        .prepare("UPDATE instance_heartbeat SET last_heartbeat = ? WHERE id = ?")
        .run(new Date().toISOString(), instanceId);
      await cleanStaleInstances(app);
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
      // Fire-and-forget cleanup: shutdown is sync from the caller's POV. The
      // DB is about to close anyway; errors here are best-effort.
      void db
        .prepare("DELETE FROM instance_heartbeat WHERE id = ?")
        .run(instanceId)
        .catch((e: any) => {
          const msg = String(e?.message ?? e);
          if (!isShutdownRace(msg)) {
            logWarn("session", `instance-lock: heartbeat delete failed: ${msg}`);
          }
        });
    },
    isPrimary: async () => {
      try {
        const first = (await db.prepare("SELECT id FROM instance_heartbeat ORDER BY started_at ASC LIMIT 1").get()) as
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
async function cleanStaleInstances(app: AppContext): Promise<void> {
  try {
    const db = app.db;
    const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();
    await db.prepare("DELETE FROM instance_heartbeat WHERE last_heartbeat < ?").run(cutoff);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (!isShutdownRace(msg)) {
      logWarn("session", `instance-lock: stale cleanup failed: ${msg}`);
    }
  }
}

/** Get count of active instances. */
export async function activeInstanceCount(app: AppContext): Promise<number> {
  try {
    const db = app.db;
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS instance_heartbeat (
          id TEXT PRIMARY KEY, pid INTEGER NOT NULL,
          started_at TEXT NOT NULL, last_heartbeat TEXT NOT NULL
        )`,
      )
      .run();
    await cleanStaleInstances(app);
    const row = (await db.prepare("SELECT COUNT(*) as count FROM instance_heartbeat").get()) as { count: number };
    return row.count;
  } catch (e: any) {
    logWarn("session", `instance-lock: activeInstanceCount failed: ${String(e?.message ?? e)}`);
    return 0;
  }
}
