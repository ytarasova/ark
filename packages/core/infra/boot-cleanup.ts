/**
 * BootCleanup -- on boot, sweeps for stale per-session config files left
 * behind by previous Ark runs.
 *
 * The liveness scan that lived here previously was redundant with
 * AppContext._rehydrateRunningSessions, which starts a probeStatus poller
 * for every running session; the poller catches dead sessions within
 * one tick (3s). Only the two local-mode file cleanup sweeps remain
 * here -- they have no equivalent elsewhere.
 *
 * Not a long-running service -- start() runs once and returns.
 * stop() is a no-op kept for Lifecycle symmetry.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { AppContext } from "../app.js";
import { safeAsync } from "../safe.js";
import { logDebug, logWarn } from "../observability/structured-log.js";

export class BootCleanup {
  constructor(private readonly app: AppContext) {}

  async start(): Promise<void> {
    if (this.app.mode.kind !== "local") return;

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

  stop(): void {
    // no-op: one-shot scan
  }
}
