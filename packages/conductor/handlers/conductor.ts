/**
 * Conductor/bridge RPC handlers.
 *
 * The old conductor HTTP server is merged into the server daemon (port 19400).
 * These JSON-RPC methods remain for CLI / protocol back-compat:
 *
 *   - conductor/status     reports the merged server as the conductor
 *   - conductor/bridge     start the local messaging bridge (slack/email)
 *   - conductor/notify     send a one-shot message via the bridge
 *
 * Bridge ops are host-local-by-nature (they read the local bridge config
 * on disk and drive outbound HTTP), so they always use the un-scoped
 * `app.config.dirs.ark`.
 */

import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { createBridge } from "../../core/integrations/bridge.js";

export function registerConductorHandlers(router: Router, app: AppContext): void {
  // ── Status ────────────────────────────────────────────────────────────────
  // The conductor is merged into the server daemon on the server port.
  // The daemon is always "running" when this handler executes (it's in-process).
  router.handle("conductor/status", async (_p, _notify, _ctx) => {
    const port = app.config.ports?.conductor ?? 19400;
    return { running: true, port, pid: process.pid };
  });

  // ── Bridge ────────────────────────────────────────────────────────────────
  // Bridge ops drive outbound delivery (Slack webhook + SMTP email) via a
  // config file at `~/.ark/bridge.json`. They are daemon-side-by-nature:
  // starting a bridge binds a polling loop to the daemon process, and
  // `conductor/notify` sends a one-shot message without leaving a live loop.
  router.handle("conductor/bridge", async (_p, _notify, _ctx) => {
    const bridge = createBridge(app.config.dirs.ark);
    if (!bridge) {
      return { ok: false, running: false, message: "no bridge config found at ~/.ark/bridge.json" };
    }
    bridge.onMessage(async (msg) => {
      const text = msg.text.trim().toLowerCase();
      if (text === "/status" || text === "status") {
        await bridge.notifyStatusSummary(app);
      } else if (text === "/sessions" || text === "sessions") {
        const sessions = await app.sessions.list({ limit: 20 });
        const lines = sessions.map((s) => `• ${s.summary ?? s.id} (${s.status})`);
        await bridge.notify(lines.join("\n") || "No sessions");
      } else {
        await bridge.notify(`Unknown command: ${text}`);
      }
    });
    return { ok: true, running: true };
  });

  router.handle("conductor/notify", async (p, _notify, _ctx) => {
    const { message } = extract<{ message: string }>(p, ["message"]);
    const bridge = createBridge(app.config.dirs.ark);
    if (!bridge) {
      return { ok: false, message: "no bridge config found at ~/.ark/bridge.json" };
    }
    await bridge.notify(message);
    bridge.stop();
    return { ok: true };
  });
}
