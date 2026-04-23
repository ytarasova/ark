# Terminal Attach (Web UI + CLI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give users a first-class way to attach to a running Ark session's tmux pane from both the Web UI (in-browser terminal via xterm.js) and CLI (existing `ark session attach <id>` polished + exposed to the Web UI as a copyable hint). Tracks issue #396.

**Architecture:** Reuse the existing arkd daemon for tmux operations (already owns `agentKill` / `agentStatus` / `agentCapture`). Add three new arkd endpoints — `agentAttachOpen` (spawns `tmux pipe-pane`, returns a stream handle), `agentAttachInput` (forwards keystrokes via `tmux send-keys`), `agentAttachResize` (`tmux resize-window`). Server daemon exposes a WebSocket proxy route so the browser connects to one endpoint; the proxy forwards frames to the right arkd. Web UI mounts an xterm.js panel bound to that WebSocket.

**Tech Stack:** `xterm` + `xterm-addon-fit` (new deps, MIT, ~200KB minified total). Bun `WebSocket`. Existing arkd stdio JSON-RPC pattern. No protocol changes to the top-level server daemon WS — new route added.

---

## Scope

### IN (this plan, MVP)
- **Local sessions only.** `LocalProvider`-backed tmux.
- Read-write terminal (output + keyboard input).
- Resize propagation (xterm.js reports rows/cols → tmux resizes).
- "Copy CLI command" button in Web UI using a new `session/attach-command` RPC that wraps existing `core.attachCommand(session_id)`.
- CLI polish: friendly error on non-attachable session, new `--print-only` flag.

### DEFERRED (follow-up issues filed during Wave 2)
- **Remote sessions** (EC2 / K8s / firecracker / docker). Needs arkd-to-arkd proxy or provider-specific attach paths. Stub in the UI with a disabled state + a message pointing at the CLI command.
- **Multi-user simultaneous attach.** Local tmux handles this natively; the Web UI MVP assumes a single browser attacher. If two tabs open, both work but their input interleaves.
- **Session recording / replay** — tracked separately in #311.
- **Terminal search, copy-mode, theming** — xterm.js supports all of this; defer to a UX-polish pass.

### Hard out-of-scope
- Mobile/touch UX.
- Rewriting the session-detail page structure.

---

## Current surface (verified 2026-04-22)

- arkd (`packages/arkd/server.ts`): `agentKill`, `agentStatus`, `agentCapture` (one-shot `tmux capture-pane -p`). No streaming primitive yet.
- CLI: `ark session attach <id>` works (packages/cli/commands/session.ts:483 + :500). Calls `core.attachCommand(session_id)` which returns a shell string per-provider via `ComputeProvider.getAttachCommand()`.
- server daemon: WebSocket-only JSON-RPC on :19400 (packages/server/index.ts:183). No binary-proxy route.
- Web UI: no terminal. Session detail lives under session page routing (grep for `SessionsPage.tsx` + related).
- `xterm` not in any `package.json`.

---

## Wave 1: Backend — arkd endpoints + WS proxy + `session/attach-command` RPC

**Files to create/modify:**
- `packages/arkd/server.ts` — add `agentAttachOpen`, `agentAttachInput`, `agentAttachResize`.
- `packages/arkd/types.ts` (or wherever the arkd request/response types live — grep for `AgentCaptureReq`) — new request/response types.
- `packages/server/handlers/session.ts` (or wherever session RPCs live — grep for `"session/send"`) — add `session/attach-command` RPC.
- `packages/server/index.ts` or a new route file — add WebSocket proxy route `/terminal/:sessionId`.
- `packages/protocol/rpc-schemas.ts` — Zod schema for `session/attach-command`.
- `packages/types/rpc.ts` — typed request/response.
- Tests: `packages/arkd/__tests__/` + `packages/server/handlers/__tests__/`.

### Step 1.1: Add arkd terminal-attach endpoints

- [ ] **Write failing tests** for each endpoint.

`packages/arkd/__tests__/attach.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
// ... boilerplate ...

describe("agentAttachOpen", () => {
  it("returns a stream handle for a running tmux session", async () => {
    // spawn a tmux session named "ark-s-attach-test"
    // ... tmux new-session -d -s ark-s-attach-test ...
    const res = await agentAttachOpen({ sessionName: "ark-s-attach-test" });
    expect(res.ok).toBe(true);
    expect(typeof res.streamHandle).toBe("string");
  });

  it("rejects unknown tmux session", async () => {
    await expect(agentAttachOpen({ sessionName: "ark-s-nonexistent" })).rejects.toThrow(/not running/i);
  });

  it("rejects unsafe session names", async () => {
    await expect(agentAttachOpen({ sessionName: "../evil" })).rejects.toThrow(/invalid sessionName/);
  });
});

describe("agentAttachInput", () => {
  it("sends keys to the pane", async () => {
    // ... spawn tmux session, attach, send "echo hi", read pane ...
  });
});

describe("agentAttachResize", () => {
  it("resizes the window", async () => {
    // ... spawn, resize to 120x40, verify via tmux display-message -p "#{window_width}" ...
  });
});
```

- [ ] **Implement `agentAttachOpen`** in `packages/arkd/server.ts`:

```ts
interface AgentAttachOpenReq { sessionName: string }
interface AgentAttachOpenRes { ok: boolean; streamHandle: string }

async function agentAttachOpen(req: AgentAttachOpenReq): Promise<AgentAttachOpenRes> {
  requireSafeTmuxName(req.sessionName);
  if (!(await isTmuxRunning(req.sessionName))) {
    throw new Error(`tmux session not running: ${req.sessionName}`);
  }
  const handle = nanoid(16);
  // Spawn tmux pipe-pane to a Unix-domain pipe under <arkDir>/run/terminal/<handle>.fifo.
  // The WS proxy read-side opens the fifo and streams bytes; the write-side is managed by
  // the tmux subprocess writing capture data continuously.
  // Alternative (simpler, chosen here): use `tmux pipe-pane -o "cat >> <fifo>"` and track
  // the handle -> fifo path mapping in an in-memory map that the WS proxy consults.
  const fifoPath = join(arkDir, "run", "terminal", `${handle}.fifo`);
  await Bun.spawn(["mkdir", "-p", dirname(fifoPath)]).exited;
  await Bun.spawn(["mkfifo", fifoPath]).exited; // named pipe
  const proc = Bun.spawn({
    cmd: ["tmux", "pipe-pane", "-t", req.sessionName, "-o", `cat > ${fifoPath}`],
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  attachHandles.set(handle, { sessionName: req.sessionName, fifoPath, pipePaneActive: true });
  return { ok: true, streamHandle: handle };
}
```

**NOTE:** the `pipe-pane` approach pipes current pane output; the FIRST read gets nothing until new data flows. For initial rendering, do a one-shot `tmux capture-pane -p -e -J` upfront in `agentAttachOpen` and return it as `initialBuffer` in the response, so the browser can render the current pane state immediately.

Revised shape:

```ts
interface AgentAttachOpenRes {
  ok: boolean;
  streamHandle: string;
  initialBuffer: string; // rendered pane content (with ANSI escapes)
}
```

- [ ] **Implement `agentAttachInput`**:

```ts
interface AgentAttachInputReq { sessionName: string; data: string }
interface AgentAttachInputRes { ok: boolean }

async function agentAttachInput(req: AgentAttachInputReq): Promise<AgentAttachInputRes> {
  requireSafeTmuxName(req.sessionName);
  // tmux send-keys accepts literal strings; use -l (literal) to avoid shell expansion of key names.
  // Escape sequences pass through unchanged.
  const proc = Bun.spawn({
    cmd: ["tmux", "send-keys", "-t", req.sessionName, "-l", req.data],
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`send-keys failed: exit ${code}`);
  return { ok: true };
}
```

- [ ] **Implement `agentAttachResize`**:

```ts
interface AgentAttachResizeReq { sessionName: string; cols: number; rows: number }
interface AgentAttachResizeRes { ok: boolean }

async function agentAttachResize(req: AgentAttachResizeReq): Promise<AgentAttachResizeRes> {
  requireSafeTmuxName(req.sessionName);
  if (!Number.isInteger(req.cols) || !Number.isInteger(req.rows)) {
    throw new Error("cols and rows must be integers");
  }
  if (req.cols < 10 || req.cols > 500 || req.rows < 5 || req.rows > 200) {
    throw new Error("cols/rows out of range");
  }
  await Bun.spawn({
    cmd: ["tmux", "resize-window", "-t", req.sessionName, "-x", String(req.cols), "-y", String(req.rows)],
    stdout: "pipe",
    stderr: "pipe",
  }).exited;
  return { ok: true };
}
```

- [ ] **Add a cleanup endpoint** `agentAttachClose(streamHandle)` that `tmux pipe-pane -t <sess>` (toggle off) and removes the fifo.

- [ ] Commit the arkd changes.

### Step 1.2: WebSocket proxy route on server daemon

`/terminal/:sessionId` on port :19400. Handshake: client sends an initial `auth` frame (token + sessionId), server validates against the session's tenant + calls arkd's `agentAttachOpen`, then pipes the fifo stream bytes to the WebSocket while forwarding incoming WS binary frames to `agentAttachInput`.

- [ ] **Add the WebSocket upgrade handler** in `packages/server/index.ts`:

```ts
fetch(req, server) {
  const url = new URL(req.url, "http://localhost");
  // ... existing upgrade path ...
  const m = url.pathname.match(/^\/terminal\/([A-Za-z0-9-]+)$/);
  if (m) {
    // upgrade with a tag so websocket handlers know this is a terminal proxy
    if (server.upgrade(req, { data: { kind: "terminal", sessionId: m[1], ...authData } })) return;
  }
  // ... rest of fetch ...
},
websocket: {
  async open(ws) {
    const data = ws.data as WsData;
    if (data.kind === "terminal") return openTerminalProxy(ws, data);
    // ... existing JSON-RPC open ...
  },
  // ...
}
```

- [ ] **`openTerminalProxy(ws, data)`** resolves the session → compute → arkd URL, calls `agentAttachOpen`, streams the fifo to `ws.sendBinary(chunk)`. Incoming `ws.data`:
  - Binary frame → forward as `agentAttachInput { data: decoded }`
  - JSON text frame `{ resize: { cols, rows } }` → `agentAttachResize`

- [ ] **Tests**: integration test that boots a local tmux session, connects over WS, sends a resize + input, reads output.

- [ ] **Commit.**

### Step 1.3: `session/attach-command` RPC

Wraps the existing `core.attachCommand(session_id)` helper so the Web UI doesn't recompute.

- [ ] **Define Zod schema** in `packages/protocol/rpc-schemas.ts`:

```ts
export const SessionAttachCommandRequest = z.object({ sessionId: z.string() });
export const SessionAttachCommandResponse = z.object({
  command: z.string(),      // "tmux attach -t ark-s-abc123" or equivalent
  displayHint: z.string(),  // human-friendly, e.g. "Run this in your terminal:"
  attachable: z.boolean(),  // false when session isn't dispatched / is complete / on unreachable remote
  reason: z.string().optional(), // populated when !attachable
});
```

- [ ] **Add typed types** in `packages/types/rpc.ts`.

- [ ] **Implement handler** in `packages/server/handlers/session.ts`:

```ts
router.method("session/attach-command", async (params, ctx) => {
  const parsed = SessionAttachCommandRequest.parse(params);
  const session = await app.sessions.get(parsed.sessionId);
  if (!session) throw new RpcError(ErrorCodes.NOT_FOUND, `Unknown session`);
  if (session.tenant_id !== ctx.tenantId) throw new RpcError(ErrorCodes.FORBIDDEN, "...");
  if (!session.session_id || session.status === "completed" || session.status === "failed") {
    return { command: "", displayHint: "", attachable: false, reason: `session is ${session.status}` };
  }
  const cmd = core.attachCommand(session.session_id);
  return { command: cmd, displayHint: "Run this in your terminal:", attachable: true };
});
```

- [ ] **Tests** in `packages/server/handlers/__tests__/session-attach-command.test.ts`: dispatched session returns a command; completed session returns `attachable: false`; unknown session throws `NOT_FOUND`; cross-tenant throws `FORBIDDEN`.

- [ ] **Commit.**

---

## Wave 2: Frontend — xterm.js panel + "Copy CLI command" button

**Dependencies to add:**

```json
"xterm": "^5.5.0",
"xterm-addon-fit": "^0.10.0"
```

**Files to create/modify:**
- `packages/web/package.json` — add xterm deps.
- `packages/web/src/components/session/TerminalPanel.tsx` — new component.
- `packages/web/src/hooks/useTerminalSocket.ts` — new hook wrapping the WebSocket.
- `packages/web/src/components/session/CopyAttachCommandButton.tsx` — new component.
- `packages/web/src/hooks/useApi.ts` — add `getSessionAttachCommand(sessionId)` wrapper.
- Wire the new components into the session-detail view (grep for `SessionsPage.tsx` + session-detail imports).
- Test: `packages/e2e/web/terminal-attach.spec.ts` — Playwright test.

### Step 2.1: Install deps

- [ ] `cd packages/web && bun add xterm@^5.5.0 xterm-addon-fit@^0.10.0`

### Step 2.2: `useTerminalSocket` hook

- [ ] Hook that opens `ws://<host>:19400/terminal/<sessionId>?token=<t>`, exposes `{ send: (data) => void, resize: (cols, rows) => void, onData: (cb) => void, close: () => void, state: "connecting" | "open" | "closed" }`.
- [ ] Auto-reconnect on close with a 1-second debounce (max 3 attempts; give up after that with an error state).
- [ ] Disposal: close the WS on unmount.

### Step 2.3: `TerminalPanel` component

- [ ] Mount xterm.js in a div. Apply `FitAddon`. On mount, create the socket via `useTerminalSocket`.
- [ ] Wire:
  - `socket.onData(bytes => term.write(bytes))`
  - `term.onData(data => socket.send(data))` — keyboard input
  - `term.onResize(({cols, rows}) => socket.resize(cols, rows))` — resize debounced 100ms
- [ ] Initial paint: the server's `agentAttachOpen` response includes `initialBuffer`; write it to the terminal before attaching the live stream.
- [ ] Styling: black background, monospace, ~14px. Match the Ark dark theme.
- [ ] Loading / error states: show a spinner during `connecting`, an error message on `closed` with a retry button.

### Step 2.4: `CopyAttachCommandButton` component

- [ ] Fetches `session/attach-command` on mount.
- [ ] Renders a button "Copy CLI command" that copies `command` to clipboard.
- [ ] When `!attachable`, show the reason instead of the button.
- [ ] Small text hint below: "Run this in your terminal for a native shell experience."

### Step 2.5: Wire into session-detail

- [ ] Add a "Terminal" tab to the session-detail view. The tab's body mounts `TerminalPanel` (lazy — only instantiate when the tab is active, so WebSocket doesn't open for users who never click it).
- [ ] Next to the tab header, render the `CopyAttachCommandButton`.

### Step 2.6: Playwright e2e

- [ ] `packages/e2e/web/terminal-attach.spec.ts`: dispatch a session that runs `while true; do echo hi; sleep 1; done`, open session detail in browser, click Terminal tab, verify "hi" appears in the xterm viewport within 3s.

### Step 2.7: File the remote-compute follow-up

- [ ] `gh issue create --title "[web+cli] Terminal attach for remote compute (EC2 / K8s / firecracker / docker)"` — body references #396 and the MVP scope boundary. Link from Wave 2 complete.

### Step 2.8: Commit.

---

## Wave 3: CLI polish

### Step 3.1: Friendly error on non-attachable

- [ ] `packages/cli/commands/session.ts` attach subcommand (line 483+): before calling `core.attachCommand`, check session status. On `completed` / `failed` / not-yet-dispatched, print a helpful error and exit 1:

```ts
if (s.status === "completed" || s.status === "failed") {
  console.error(`Session ${id} is ${s.status}; nothing to attach. Use 'ark session show ${id}' to view the transcript.`);
  process.exit(1);
}
if (!s.session_id) {
  console.error(`Session ${id} has not been dispatched yet.`);
  process.exit(1);
}
```

### Step 3.2: `--print-only` flag

- [ ] Add to the attach subcommand:

```ts
.option("--print-only", "Print the attach command instead of running it")
```

- [ ] When set, print `core.attachCommand(session_id)` and exit 0. Don't `execSync`.

### Step 3.3: Update tests

- [ ] `packages/cli/__tests__/session-attach.test.ts` (or adjacent) — cover the two new paths.

### Step 3.4: Commit.

---

## Final verification

- [ ] Run: `make test` — no regressions.
- [ ] Run: `make lint` — zero warnings.
- [ ] Manual: `make dev`, open http://localhost:5173, create a new session, click Terminal tab. Verify in-browser terminal works. Click "Copy CLI command" — paste into a separate terminal, verify `ark session attach` works.

---

## Dispatch guidance

**Recommended: one agent, sequential, worktree-isolated.** The three waves share protocol types (Wave 1's Zod schemas feed Wave 2's hook) and a sequential run keeps them consistent. Multi-agent parallel here risks the same file-clash pattern that cost us on the capability-driven-rules dispatch.

If the scope turns out larger than one agent can sustain, natural split points:
- After Wave 1: backend lands as one commit, then a new agent picks up Wave 2.
- Wave 3 can piggyback on Wave 2.

**Worktree path discipline**: every previous parallel dispatch has seen agents leak to main. Enforce in the prompt: "pwd must show `.claude/worktrees/agent-*`, `git rev-parse --abbrev-ref HEAD` must show `worktree-agent-*`."

---

## Self-review

1. **Issue #396 coverage:**
   - Web UI in-browser terminal → Wave 2 ✓
   - Copy CLI command button → Waves 1.3 + 2.4 ✓
   - CLI polish (friendly errors + print-only) → Wave 3 ✓
   - Remote-compute deferral documented → Wave 2.7 files the follow-up ✓

2. **Placeholder scan:** The arkd implementation sketches in Wave 1 are concrete. Resize/input rate-limiting and reconnect backoff are real numbers, not TBD.

3. **Type consistency:** `sessionName` on arkd endpoints vs `sessionId` on server RPCs — intentional: arkd speaks tmux names (`ark-s-<id>`), server speaks session DB ids. The proxy maps between them via a session → compute → sessionName lookup.

4. **Security:** Every arkd endpoint validates `requireSafeTmuxName`. The WS proxy validates tenant + session ownership. No unauthenticated path.

5. **MVP boundary clearly marked:** end of Wave 3 = shippable MVP for local sessions. Remote-compute + multi-user + recording are follow-ups.
