/**
 * /terminal/:sessionId WS tenant-ownership gate tests.
 *
 * Round-2 P0-1 (server): before the fix, the Authorization header + ?token=
 * query param were captured into `TerminalData` but never validated before
 * the WS upgrade. A viewer token from tenant A could open /terminal/<tenant-B-
 * session-id>, receive live pane bytes via arkd's attach stream, and inject
 * keystrokes via `send-keys -l`.
 *
 * These tests configure `attachAuth` with an ApiKeyManager that issues real
 * admin + viewer keys per tenant, create sessions under two different tenant
 * scopes, and assert:
 *   - viewer in tenant A gets 403 on tenant B's session id
 *   - admin in tenant A succeeds on any tenant's session id
 *   - own-tenant viewer succeeds on its own session id
 *   - no token (and requireToken=true) gets 403 (anonymous)
 *
 * No real tmux pane is required because the gate fires BEFORE the WS upgrade;
 * the test asserts the HTTP response code returned by the fetch handler. For
 * the positive (own-tenant) success case we install a live tmux session so
 * the upgrade + connected envelope can flow end-to-end.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../../core/app.js";
import { ArkServer } from "../index.js";
import { registerAllHandlers } from "../register.js";
import { allocatePort } from "../../core/config/port-allocator.js";
import { execFileSync } from "child_process";
import { tmuxBin } from "../../core/infra/tmux.js";
import { startArkd } from "../../arkd/server.js";

let app: AppContext;
let server: ArkServer;
let ws: { stop(): void };
let arkd: { stop(): void };
let port: number;
let arkdPort: number;
let baseWs: string;
const spawnedTmuxSessions: string[] = [];
let prevArkdUrl: string | undefined;

// Tokens issued in beforeAll for the different tenant/role permutations.
let tenantAAdminToken: string;
let tenantAViewerToken: string;

beforeAll(async () => {
  arkdPort = await allocatePort();
  prevArkdUrl = process.env.ARK_ARKD_URL;
  process.env.ARK_ARKD_URL = `http://localhost:${arkdPort}`;
  arkd = startArkd(arkdPort, { quiet: true });

  // Enable auth + two tenants. We flip `requireToken` on the already-built
  // config so the server's `attachAuth` path kicks in. In local profile the
  // default is `false`; flipping to true here exercises the gate.
  app = await AppContext.forTestAsync();
  (app.config.authSection as { requireToken: boolean }).requireToken = true;
  await app.boot();

  // Mint admin + viewer keys in two separate tenants.
  ({ key: tenantAAdminToken } = await app.apiKeys.create("tenant-a", "admin-a", "admin"));
  ({ key: tenantAViewerToken } = await app.apiKeys.create("tenant-a", "viewer-a", "viewer"));

  server = new ArkServer();
  // Skip requireInitialization so our tests don't have to run the handshake.
  (server.router as any).requireInit = false;
  registerAllHandlers(server.router, app);
  server.attachAuth(app);
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

async function httpGet(path: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`http://localhost:${port}${path}`, { headers });
}

describe("/terminal/:sessionId tenant-ownership gate (round-2 P0-1 server)", () => {
  it("403s when a viewer from tenant A requests tenant B's session", async () => {
    const tenantB = app.forTenant("tenant-b");
    const session = await tenantB.sessions.create({ summary: "tenant-b private" });
    // Put the session in a state that would normally be attachable.
    await tenantB.sessions.update(session.id, { session_id: "arktest-bogus" });

    const resp = await httpGet(`/terminal/${session.id}`, tenantAViewerToken);
    expect(resp.status).toBe(403);
  });

  it("admin token succeeds on any tenant's session (bypasses same-tenant gate)", async () => {
    // Admin in tenant A should still be allowed through the gate for a
    // tenant-B session. We don't spawn a real tmux pane here; the gate
    // decision is reflected in the HTTP response code (403 would mean gate
    // rejected; 409 "no pane" means gate accepted and we fell through to
    // the attachability check).
    const tenantB = app.forTenant("tenant-b");
    const session = await tenantB.sessions.create({ summary: "tenant-b admin-override" });

    const resp = await httpGet(`/terminal/${session.id}`, tenantAAdminToken);
    // Gate passed -- but session has no tmux pane (session_id null), so we
    // hit 409. Any of 101 (upgrade ok), 200 (shouldn't happen on GET), or
    // 409 (no pane) proves the tenant gate did not reject.
    expect([101, 200, 409]).toContain(resp.status);
    expect(resp.status).not.toBe(403);
  });

  it("own-tenant viewer succeeds on their own session", async () => {
    const tenantA = app.forTenant("tenant-a");
    const tmuxName = `arktest-tenant-a-${Date.now().toString(36)}`;
    spawnedTmuxSessions.push(tmuxName);
    execFileSync(
      tmuxBin(),
      ["new-session", "-d", "-s", tmuxName, "-x", "120", "-y", "30", "bash", "-c", "echo tenant-a-hi; sleep 60"],
      { stdio: "pipe" },
    );

    const session = await tenantA.sessions.create({ summary: "tenant-a own" });
    await tenantA.sessions.update(session.id, { session_id: tmuxName });

    // Open the WS with tenant A viewer token -- should succeed with a
    // `connected` first-message envelope.
    const { ws: wsClient, firstMessage } = await openSocketAuthed(
      `${baseWs}/terminal/${session.id}`,
      tenantAViewerToken,
    );
    const parsed = JSON.parse(firstMessage as string);
    expect(parsed.type).toBe("connected");
    expect(parsed.sessionId).toBe(session.id);
    wsClient.close();
  }, 15_000);

  it("no token when requireToken=true is anonymous -> 403 on tenant session", async () => {
    const tenantB = app.forTenant("tenant-b");
    const session = await tenantB.sessions.create({ summary: "tenant-b anon-reject" });
    await tenantB.sessions.update(session.id, { session_id: "arktest-bogus2" });

    const resp = await httpGet(`/terminal/${session.id}`);
    // anonymousContext().tenantId === "anonymous" and isAdmin === false,
    // so the `tenant_id !== ctx.tenantId && !ctx.isAdmin` branch rejects.
    expect(resp.status).toBe(403);
  });

  it("404 for non-existent session (no existence leak)", async () => {
    const resp = await httpGet("/terminal/s-nonexistent-xyz", tenantAViewerToken);
    expect(resp.status).toBe(404);
  });
});

function openSocketAuthed(url: string, token: string): Promise<{ ws: WebSocket; firstMessage: string | ArrayBuffer }> {
  return new Promise((resolve, reject) => {
    // WebSocket constructor does not accept custom headers in the browser
    // spec, but Bun's fetch-style WebSocket does via the init bag. Fallback
    // to ?token= query param which the server also accepts.
    const sep = url.includes("?") ? "&" : "?";
    const socket = new WebSocket(`${url}${sep}token=${encodeURIComponent(token)}`);
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
