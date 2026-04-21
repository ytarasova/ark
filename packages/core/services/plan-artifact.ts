/**
 * Plan artifact capture: lift PLAN.md from the worktree into BlobStore so
 * downstream stages can read it without touching the filesystem on their
 * replica. Called from the stage-advance path right before a stage flips
 * to "completed".
 *
 * PLAN.md is the planner agent's deliverable in the docs / sdlc flows.
 * The implementer stage used to `readFileSync` it off the worktree, which
 * breaks on hosted deployments where the implement stage may land on a
 * different replica than the planner. After this capture the implement
 * stage reads via `app.blobStore.get(session.config.plan_md_locator)`
 * with filesystem fallback only for the same-replica local path.
 */

import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";

import type { AppContext } from "../app.js";
import type { Session } from "../../types/index.js";
import { logDebug, logWarn } from "../observability/structured-log.js";

const MAX_PLAN_BYTES = 1 * 1024 * 1024; // 1 MiB -- plans are text; reject pathological inputs.

/**
 * If a PLAN.md exists in the session's worktree, upload the current bytes to
 * BlobStore and stamp the locator on `session.config.plan_md_locator`.
 *
 * Idempotent-ish: we overwrite any existing locator so the latest PLAN.md
 * wins. Writes are skipped when the file is missing, empty, too large,
 * unchanged since the last capture (matched by size+mtime), or the session
 * has no worktreesDir layout.
 */
export async function capturePlanMdIfPresent(app: AppContext, session: Session): Promise<void> {
  try {
    const wtDir = join(app.config.worktreesDir, session.id);
    const planPath = join(wtDir, "PLAN.md");
    if (!existsSync(planPath)) return;

    const st = statSync(planPath);
    if (st.size === 0) return;
    if (st.size > MAX_PLAN_BYTES) {
      logWarn("session", `PLAN.md for ${session.id} is ${st.size} bytes; exceeds ${MAX_PLAN_BYTES}, skipping capture`);
      return;
    }

    // Short-circuit when nothing changed. Avoids rewriting the same locator
    // on every stage-advance tick (handoffs + retries can trigger advance()
    // multiple times against the same PLAN.md).
    const fingerprint = `${st.size}:${Math.floor(st.mtimeMs)}`;
    const priorFingerprint = (session.config as any)?.plan_md_fingerprint as string | undefined;
    if (priorFingerprint === fingerprint && (session.config as any)?.plan_md_locator) return;

    const bytes = readFileSync(planPath);
    const meta = await app.blobStore.put(
      { tenantId: session.tenant_id, namespace: "plan-md", id: session.id, filename: "PLAN.md" },
      bytes,
      { contentType: "text/markdown; charset=utf-8" },
    );

    app.sessions.mergeConfig(session.id, {
      plan_md_locator: meta.locator,
      plan_md_fingerprint: fingerprint,
    });
  } catch (e: any) {
    // Capture is best-effort -- a missing blob at read time falls back to
    // the worktree FS read. Logging here surfaces unexpected failures (ENOSPC
    // on the blob backend, bad permissions on the worktree) without blocking
    // stage advancement.
    logDebug("session", `capturePlanMdIfPresent failed for ${session.id}: ${e?.message ?? e}`);
  }
}

/**
 * Load PLAN.md bytes from BlobStore when a locator is on the session row;
 * otherwise fall through to a direct worktree read. Returns null if neither
 * source yields bytes so callers can skip the "no PLAN.md" branch cleanly.
 */
export async function readPlanMd(app: AppContext, session: Session): Promise<string | null> {
  const locator = (session.config as any)?.plan_md_locator as string | undefined;
  if (locator) {
    try {
      const { bytes } = await app.blobStore.get(locator, session.tenant_id);
      return bytes.toString("utf-8");
    } catch (e: any) {
      logWarn("session", `plan-md blob read failed for ${session.id}: ${e?.message ?? e}`);
    }
  }

  const wtDir = join(app.config.worktreesDir, session.id);
  const planPath = join(wtDir, "PLAN.md");
  if (existsSync(planPath)) {
    try {
      return readFileSync(planPath, "utf-8");
    } catch (e: any) {
      logWarn("session", `plan-md fs read failed for ${session.id}: ${e?.message ?? e}`);
    }
  }
  return null;
}
