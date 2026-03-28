# ArkD — Universal Agent Daemon

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a universal HTTP daemon (arkd) that runs on every compute target — localhost, Docker, EC2, future Firecracker — providing a typed JSON-over-HTTP API for file ops, process execution, agent lifecycle, metrics, and port probing.

**Architecture:** Bun.serve() HTTP server with typed request/response contracts. Each compute provider gets an `arkdUrl` field and delegates operations through `ArkdClient`. Phase 1 builds the daemon + client + tests; Phase 2 refactors providers to use it.

**Tech Stack:** Bun (server + runtime), TypeScript, bun:test

---

### Task 1: Shared types — `packages/arkd/types.ts`

**Files:**
- Create: `packages/arkd/types.ts`
- Create: `packages/arkd/package.json`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@ark/arkd",
  "version": "0.1.0",
  "type": "module",
  "main": "index.ts"
}
```

- [ ] **Step 2: Write types.ts with all request/response contracts**

```typescript
/**
 * ArkD — typed request/response contracts for the agent daemon HTTP API.
 *
 * Every compute target (local, Docker, EC2, Firecracker) runs an arkd
 * instance. Providers talk to it via ArkdClient instead of SSH/exec/tmux.
 */

// ── File operations ─────────────────────────────────────────────────────────

export interface ReadFileReq  { path: string }
export interface ReadFileRes  { content: string; size: number }

export interface WriteFileReq { path: string; content: string; mode?: number }
export interface WriteFileRes { ok: true; bytesWritten: number }

export interface ListDirReq   { path: string; recursive?: boolean }
export interface ListDirRes   { entries: DirEntry[] }
export interface DirEntry     { name: string; path: string; type: "file" | "dir" | "symlink"; size: number }

export interface StatReq      { path: string }
export interface StatRes      { exists: boolean; type?: "file" | "dir" | "symlink"; size?: number; mtime?: string }

export interface MkdirReq     { path: string; recursive?: boolean }
export interface MkdirRes     { ok: true }

// ── Process execution ───────────────────────────────────────────────────────

export interface ExecReq {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;       // ms, default 30_000
  stdin?: string;
}
export interface ExecRes {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

// ── Agent lifecycle ─────────────────────────────────────────────────────────

export interface AgentLaunchReq {
  sessionName: string;    // tmux session name
  script: string;         // launcher script content
  workdir: string;
}
export interface AgentLaunchRes { ok: true; pid?: number }

export interface AgentKillReq   { sessionName: string }
export interface AgentKillRes   { ok: true; wasRunning: boolean }

export interface AgentStatusReq { sessionName: string }
export interface AgentStatusRes { running: boolean; pid?: number }

export interface AgentCaptureReq { sessionName: string; lines?: number }
export interface AgentCaptureRes { output: string }

// ── System ──────────────────────────────────────────────────────────────────

export interface MetricsRes {
  cpu: number;
  memUsedGb: number;
  memTotalGb: number;
  memPct: number;
  diskPct: number;
  uptime: string;
}

export interface ProbePortsReq  { ports: number[] }
export interface ProbePortsRes  { results: { port: number; listening: boolean }[] }

export interface HealthRes {
  status: "ok";
  version: string;
  hostname: string;
  platform: string;
}

// ── Error envelope ──────────────────────────────────────────────────────────

export interface ArkdError {
  error: string;
  code?: string;
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/arkd/
git commit -m "feat(arkd): add typed request/response contracts"
```

---

### Task 2: Server — `packages/arkd/server.ts`

**Files:**
- Create: `packages/arkd/server.ts`

- [ ] **Step 1: Implement the HTTP server**

The server uses `Bun.serve()` with a router that dispatches to handler functions. Each route parses JSON, calls the handler, and returns JSON.

Routes:
- `GET  /health` → HealthRes
- `POST /file/read` → ReadFileRes
- `POST /file/write` → WriteFileRes
- `POST /file/stat` → StatRes
- `POST /file/mkdir` → MkdirRes
- `POST /file/list` → ListDirRes
- `POST /exec` → ExecRes
- `POST /agent/launch` → AgentLaunchRes
- `POST /agent/kill` → AgentKillRes
- `POST /agent/status` → AgentStatusRes
- `POST /agent/capture` → AgentCaptureRes
- `GET  /metrics` → MetricsRes
- `POST /ports/probe` → ProbePortsRes

Implementation notes:
- File ops use `node:fs` (readFile, writeFile, stat, mkdir, readdir)
- Exec uses `Bun.spawn()` for process execution (safe: takes array args, no shell injection)
- Agent ops use tmux via `Bun.spawn()` calls to `tmux new-session`, `tmux kill-session`, etc.
- Metrics parsed from `/proc` on Linux, `sysctl`/`vm_stat` on macOS
- Port probing uses `Bun.spawn()` with `lsof` (macOS) or `ss` (Linux)

- [ ] **Step 2: Commit**

```bash
git add packages/arkd/server.ts
git commit -m "feat(arkd): HTTP server with all route handlers"
```

---

### Task 3: Server tests — `packages/arkd/__tests__/server.test.ts`

**Files:**
- Create: `packages/arkd/__tests__/server.test.ts`

- [ ] **Step 1: Write comprehensive server tests**

Tests start the server on a test port, exercise each endpoint, and verify responses.

Test cases:
1. `GET /health` returns status, version, hostname, platform
2. `POST /file/write` + `POST /file/read` round-trip
3. `POST /file/stat` returns exists/size for real file, exists=false for missing
4. `POST /file/mkdir` creates nested dirs
5. `POST /file/list` returns entries with types
6. `POST /exec` runs a command and captures stdout/stderr/exitCode
7. `POST /exec` with timeout returns timedOut=true
8. `POST /agent/launch` + `POST /agent/status` + `POST /agent/capture` + `POST /agent/kill` lifecycle
9. `POST /ports/probe` detects the arkd server's own port as listening
10. `GET /metrics` returns cpu, mem, disk fields
11. Error cases: read nonexistent file → 404, invalid JSON → 400

- [ ] **Step 2: Run tests**

```bash
bun test packages/arkd
```

- [ ] **Step 3: Commit**

```bash
git add packages/arkd/__tests__/
git commit -m "test(arkd): comprehensive server endpoint tests"
```

---

### Task 4: Client — `packages/arkd/client.ts`

**Files:**
- Create: `packages/arkd/client.ts`

- [ ] **Step 1: Implement ArkdClient**

Typed HTTP wrapper that providers use instead of SSH/exec/tmux:

```typescript
export class ArkdClient {
  constructor(private baseUrl: string) {}

  // File ops
  async readFile(path: string): Promise<ReadFileRes> { ... }
  async writeFile(req: WriteFileReq): Promise<WriteFileRes> { ... }
  async stat(path: string): Promise<StatRes> { ... }
  async mkdir(req: MkdirReq): Promise<MkdirRes> { ... }
  async listDir(req: ListDirReq): Promise<ListDirRes> { ... }

  // Exec
  async exec(req: ExecReq): Promise<ExecRes> { ... }

  // Agent lifecycle
  async launchAgent(req: AgentLaunchReq): Promise<AgentLaunchRes> { ... }
  async killAgent(req: AgentKillReq): Promise<AgentKillRes> { ... }
  async agentStatus(req: AgentStatusReq): Promise<AgentStatusRes> { ... }
  async captureOutput(req: AgentCaptureReq): Promise<AgentCaptureRes> { ... }

  // System
  async health(): Promise<HealthRes> { ... }
  async metrics(): Promise<MetricsRes> { ... }
  async probePorts(ports: number[]): Promise<ProbePortsRes> { ... }

  // Internal: typed fetch with error handling
  private async post<Req, Res>(path: string, body: Req): Promise<Res> { ... }
  private async get<Res>(path: string): Promise<Res> { ... }
}
```

Each method delegates to `post()` or `get()` which handles JSON serialization, error responses, and timeouts.

- [ ] **Step 2: Commit**

```bash
git add packages/arkd/client.ts
git commit -m "feat(arkd): ArkdClient typed HTTP wrapper"
```

---

### Task 5: Client tests — `packages/arkd/__tests__/client.test.ts`

**Files:**
- Create: `packages/arkd/__tests__/client.test.ts`

- [ ] **Step 1: Write client integration tests**

Tests start a real arkd server, create an ArkdClient, and exercise the client methods against the live server:

1. `client.health()` returns valid HealthRes
2. `client.writeFile()` + `client.readFile()` round-trip
3. `client.stat()` for existing and nonexistent files
4. `client.exec({ command: "echo", args: ["hello"] })` returns stdout
5. `client.exec()` with bad command returns non-zero exitCode
6. Agent lifecycle: launch → status(running) → capture → kill → status(not running)
7. `client.probePorts()` detects server's port
8. `client.metrics()` returns numeric fields
9. Error handling: client to dead server throws with clear message

- [ ] **Step 2: Run tests**

```bash
bun test packages/arkd
```

- [ ] **Step 3: Commit**

```bash
git add packages/arkd/__tests__/client.test.ts
git commit -m "test(arkd): client integration tests against live server"
```

---

### Task 6: Index + CLI entry point — `packages/arkd/index.ts`

**Files:**
- Create: `packages/arkd/index.ts`
- Modify: `packages/cli/index.ts` — add `ark arkd` subcommand

- [ ] **Step 1: Create index.ts re-exports**

```typescript
export { startArkd } from "./server.js";
export { ArkdClient } from "./client.js";
export type * from "./types.js";
```

- [ ] **Step 2: Add CLI subcommand**

Add `ark arkd [port]` command that starts the daemon in the foreground. Default port 19300.

- [ ] **Step 3: Run all tests**

```bash
bun test packages/arkd
```

- [ ] **Step 4: Commit**

```bash
git add packages/arkd/index.ts packages/cli/index.ts
git commit -m "feat(arkd): index re-exports + CLI entry point"
```

---

### Task 7: Merge to main

- [ ] **Step 1: Run full test suite**

```bash
bun test
```

- [ ] **Step 2: Merge**

```bash
git checkout main && git merge ark-s-841977
```
