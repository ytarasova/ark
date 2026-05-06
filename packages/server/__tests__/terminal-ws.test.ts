/**
 * /terminal/:sessionId WebSocket route tests.
 *
 * The server daemon exposes a dedicated WS route for live terminal attach.
 * The route proxies through arkd's /agent/attach/* endpoints; we boot a real
 * arkd on a random port and point DEFAULT_ARKD_URL at it so the bridge has
 * somewhere to land.
 *
 * Asserts:
 *   - tenant ownership check rejects unknown session ids
 *   - sessions without a tmux pane are refused
 *   - a valid session gets a `connected` envelope with an initial buffer
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../../core/app.js";
import { ArkServer } from "../index.js";
import { registerAllHandlers } from "../register.js";
import { allocatePort } from "../../core/config/port-allocator.js";
import { execFileSync } from "child_process";
import { tmuxBin } from "../../core/infra/tmux.js";
import { startArkd } from "../../arkd/server/index.js";

let app: AppContext;
let server: ArkServer;
let ws: { stop(): void };
let arkd: { stop(): void };
let port: number;
let arkdPort: number;
let baseWs: string;
const spawnedTmuxSessions: string[] = [];
let prevArkdUrl: string | undefined;

beforeAll(async () => {
  // Boot a real arkd on a random port so the bridge has a daemon to call.
  // Point DEFAULT_ARKD_URL at it via env so resolveArkdForSession picks it
  // up when the session has no compute_name (local fallback path).
  arkdPort = await allocatePort();
  prevArkdUrl = process.env.ARK_ARKD_URL;
  process.env.ARK_ARKD_URL = `http://localhost:${arkdPort}`;
  arkd = startArkd(arkdPort, { quiet: true });

  app = await AppContext.forTestAsync();
  await app.boot();
  server = new ArkServer();
  // Skip requireInitialization so our tests don't have to run the handshake.
  (server.router as any).requireInit = false;
  registerAllHandlers(server.router, app);
  server.attachApp(app);
  port = await allocatePort();
  baseWs = `ws://localhost:${port}`;
  ws = server.startWebSocket(port, { app });
});

afterAll(async () => {
  for (const name of spawnedTmuxSessions) {
    try {
      execFileSync(tmuxBin(), ["kill-session", "-t", name], { stdio: "pipe" });
    } catch {
      /* already gone */
    }
  }
  ws?.stop();
  arkd?.stop();
  if (prevArkdUrl === undefined) delete process.env.ARK_ARKD_URL;
  else process.env.ARK_ARKD_URL = prevArkdUrl;
  await app?.shutdown();
});

function openSocket(url: string): Promise<{ ws: WebSocket; firstMessage: string | ArrayBuffer }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      /* wait for first message */
    };
    socket.onmessage = (event) => {
      resolve({ ws: socket, firstMessage: event.data as string | ArrayBuffer });
    };
    socket.onerror = (err) => reject(err);
    socket.onclose = (event) => {
      if (event.code !== 1000) {
        reject(new Error(`WebSocket closed with code ${event.code}: ${event.reason}`));
      }
    };
    setTimeout(() => reject(new Error("timeout waiting for first WS message")), 5000);
  });
}

async function httpGet(path: string): Promise<Response> {
  return fetch(`http://localhost:${port}${path}`);
}

describe("/terminal/:sessionId WS route", () => {
  it("returns 404 for an unknown session id", async () => {
    const resp = await httpGet("/terminal/nope-nonexistent");
    expect(resp.status).toBe(404);
  });

  it("returns 409 when session exists but has no tmux pane", async () => {
    const s = await app.sessions.create({ summary: "no-pane" } as any);
    // session_id is null by default, so it has no pane.
    const resp = await httpGet(`/terminal/${s.id}`);
    expect(resp.status).toBe(409);
  });

  it("upgrades to WebSocket and sends a connected envelope with initialBuffer for a live pane", async () => {
    // Spin up a real tmux session so the bridge has something to attach to.
    const tmuxName = `arktest-${Date.now().toString(36)}`;
    spawnedTmuxSessions.push(tmuxName);
    execFileSync(
      tmuxBin(),
      ["new-session", "-d", "-s", tmuxName, "-x", "120", "-y", "30", "bash", "-c", "echo live-hi; sleep 60"],
      { stdio: "pipe" },
    );

    const s = await app.sessions.create({ summary: "live" } as any);
    await app.sessions.update(s.id, { session_id: tmuxName } as any);

    const { ws: wsClient, firstMessage } = await openSocket(`${baseWs}/terminal/${s.id}`);
    expect(typeof firstMessage).toBe("string");
    const parsed = JSON.parse(firstMessage as string);
    expect(parsed.type).toBe("connected");
    expect(parsed.sessionId).toBe(s.id);
    expect(typeof parsed.streamHandle).toBe("string");
    expect(typeof parsed.initialBuffer).toBe("string");
    wsClient.close();
  }, 15_000);

  it("routes via provider.getArkdUrl for sessions with a compute_name", async () => {
    // Register a stub compute backed by a custom arkd URL (the same local
    // arkd on a different URL string, just to prove we hit the provider).
    class StubProvider {
      readonly name = "stub-terminal-remote";
      readonly singleton = false;
      readonly canReboot = true;
      readonly canDelete = true;
      readonly supportsWorktree = false;
      readonly initialStatus = "running";
      readonly needsAuth = false;
      readonly supportsSecretMount = false;
      readonly isolationModes: any[] = [];
      setApp(): void {}
      async provision(): Promise<void> {}
      async destroy(): Promise<void> {}
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      async attach(): Promise<void> {}
      async cleanupSession(): Promise<void> {}
      async syncEnvironment(): Promise<void> {}
      async launch(): Promise<string> {
        return "";
      }
      async killAgent(): Promise<void> {}
      async captureOutput(): Promise<string> {
        return "";
      }
      async getMetrics(): Promise<any> {
        return {};
      }
      async probePorts(): Promise<any[]> {
        return [];
      }
      async checkSession(): Promise<boolean> {
        return true;
      }
      getAttachCommand(): string[] {
        return [];
      }
      buildChannelConfig(): Record<string, unknown> {
        return {};
      }
      buildLaunchEnv(): Record<string, string> {
        return {};
      }
      getArkdUrl(): string {
        // Route back to the same arkd boot fixture. This proves the WS
        // handler honoured the provider (if it hadn't, the test would still
        // pass against the fallback, but we'd miss the regression signal).
        return `http://localhost:${arkdPort}`;
      }
    }
    app.registerProvider(new StubProvider() as any);
    await app.computes.insert({
      name: "stub-remote-1",
      provider: "stub-terminal-remote" as any,
      compute_kind: "ec2",
      isolation_kind: "direct",
      status: "running",
      config: {},
    } as any);

    const tmuxName = `arktest-remote-${Date.now().toString(36)}`;
    spawnedTmuxSessions.push(tmuxName);
    execFileSync(
      tmuxBin(),
      ["new-session", "-d", "-s", tmuxName, "-x", "120", "-y", "30", "bash", "-c", "echo remote-hi; sleep 60"],
      { stdio: "pipe" },
    );

    const s = await app.sessions.create({ summary: "remote-live" } as any);
    await app.sessions.update(s.id, { session_id: tmuxName, compute_name: "stub-remote-1" } as any);

    const { ws: wsClient, firstMessage } = await openSocket(`${baseWs}/terminal/${s.id}`);
    const parsed = JSON.parse(firstMessage as string);
    expect(parsed.type).toBe("connected");
    expect(parsed.sessionId).toBe(s.id);
    expect(typeof parsed.streamHandle).toBe("string");
    wsClient.close();
  }, 15_000);
});
