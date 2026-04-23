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

    await safeAsync("boot: detect stale sessions", async () => {
      const { sessionExistsAsync } = await import("./tmux.js");
      // Sweep every tenant -- stale tmux sessions can exist under any tenant
      // in hosted mode, not just "default". Route the follow-up update + event
      // log through the session's own tenant scope so tenant-scoped repos
      // receive the write.
      const running = await this.app.sessions.listAcrossTenants({ status: "running" });
      for (const s of running) {
        if (s.session_id && !(await sessionExistsAsync(s.session_id))) {
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
