/**
 * StaleStateDetector -- on boot, sweeps for orphaned sessions + stale
 * hook/mcp config files left behind by previous ark runs.
 *
 * Not a long-running service -- `start()` runs the scan once and
 * returns. `stop()` is a no-op kept for Lifecycle symmetry.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { AppContext } from "../app.js";
import type { Session } from "../../types/index.js";
import { safeAsync } from "../safe.js";
import { logDebug, logWarn } from "../observability/structured-log.js";

export class StaleStateDetector {
  private _orphaned: Session[] = [];

  constructor(private readonly app: AppContext) {}

  get orphanedSessions(): Session[] {
    return this._orphaned;
  }

  async start(): Promise<void> {
    await safeAsync("boot: detect orphaned sessions", async () => {
      const { findOrphanedSessions } = await import("../session/checkpoint.js");
      const orphaned = await findOrphanedSessions(this.app);
      if (orphaned.length > 0) {
        this._orphaned = orphaned;
        for (const s of orphaned) {
          logWarn("session", `Orphaned session detected: ${s.id} (status: ${s.status}, stage: ${s.stage})`);
        }
      }
    });

    // The two cwd-based sweeps below assume a single-user laptop layout:
    // `process.cwd()` is the user's repo and the stale `.claude/...` /
    // `.mcp.json` files were written by a previous Ark run on the same
    // machine. In hosted mode `process.cwd()` is the conductor pod's
    // container working directory -- there's nothing meaningful to clean up
    // there, and the files would belong to whichever pod replica happened
    // to write them, not to a tenant. Skip both sweeps in hosted mode.
    if (this.app.mode.kind === "local") {
      await safeAsync("boot: cleanup stale hooks", async () => {
        const cwd = process.cwd();
        const settingsPath = join(cwd, ".claude", "settings.local.json");
        if (!existsSync(settingsPath)) return;
        try {
          const content = JSON.parse(readFileSync(settingsPath, "utf-8"));
          const cmd = content?.hooks?.Stop?.[0]?.hooks?.[0]?.command ?? "";
          if (!cmd.includes("ark-status")) return;
          const match = cmd.match(/session=([^'&\s]+)/);
          const sid = match?.[1];
          if (!sid) return;
          const session = await this.app.sessions.get(sid);
          if (!session || !["running", "waiting"].includes(session.status)) {
            logWarn(
              "session",
              `Removing stale settings for ${sid} from ${cwd} (status: ${session?.status ?? "not found"})`,
            );
            const { removeSettings } = await import("../claude/claude.js");
            removeSettings(cwd);
          }
        } catch {
          logDebug("general", "settings.local.json may be malformed; safe to skip");
        }
      });

      await safeAsync("boot: cleanup stale mcp config", async () => {
        const cwd = process.cwd();
        const mcpPath = join(cwd, ".mcp.json");
        if (!existsSync(mcpPath)) return;
        try {
          const content = JSON.parse(readFileSync(mcpPath, "utf-8"));
          const channelEnv = content?.mcpServers?.["ark-channel"]?.env;
          if (!channelEnv?.ARK_SESSION_ID) return;
          const sid = channelEnv.ARK_SESSION_ID;
          const session = await this.app.sessions.get(sid);
          if (!session || !["running", "waiting"].includes(session.status)) {
            const { removeChannelConfig } = await import("../claude/claude.js");
            removeChannelConfig(cwd);
          }
        } catch {
          logDebug("general", ".mcp.json may be malformed; safe to skip");
        }
      });
    }

    await safeAsync("boot: detect stale sessions", async () => {
      const { sessionExistsAsync } = await import("./tmux.js");
      // Sweep every tenant -- stale tmux sessions can exist under any tenant
      // in hosted mode, not just "default". Route the follow-up update + event
      // log through the session's own tenant scope so tenant-scoped repos
      // receive the write.
      const running = await this.app.sessions.listAcrossTenants({ status: "running" });
      for (const s of running) {
        if (!s.session_id) continue;

        // Provider-aware liveness check: for any session whose compute has a
        // remote provider (EC2 / k8s / etc.), `tmux has-session` on the
        // conductor host is meaningless -- the pane lives on the worker.
        // Ask the provider via arkd instead. A bare local check would mark
        // every remote session "Agent process exited while Ark was not
        // running" on every daemon reload (#422 family). Local sessions
        // (no compute or local provider with no checkSession) keep the
        // legacy local-tmux check.
        let alive: boolean;
        try {
          const tenantApp = this.app.forTenant(s.tenant_id);
          const { provider, compute } = await tenantApp.resolveProvider(s);
          if (provider?.checkSession && compute) {
            alive = await provider.checkSession(compute, s.session_id, s);
          } else {
            alive = await sessionExistsAsync(s.session_id);
          }
        } catch {
          // Provider lookup itself failed (e.g. expired AWS creds at boot).
          // Don't treat as dead -- a transient cred issue must not nuke
          // every running remote session. Skip this scan; the next status
          // poll will catch a genuinely-dead session via the same path
          // when creds are healthy.
          continue;
        }

        if (!alive) {
          const tenantApp = this.app.forTenant(s.tenant_id);
          await tenantApp.sessions.update(s.id, {
            status: "failed",
            error: "Agent process exited while Ark was not running",
            session_id: null,
          });
          await tenantApp.events.log(s.id, "session_stale_detected", { actor: "system" });
        }
      }
    });
  }

  stop(): void {
    // no-op: this is a one-shot scan, not a long-running service
  }
}
