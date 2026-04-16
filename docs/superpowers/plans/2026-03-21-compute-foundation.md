# Compute Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the `packages/compute/` package with the ComputeProvider interface, host CRUD in SQLite, arc.json parser, and a working local provider -- the foundation that all other compute providers (EC2, Docker, K8s) build on.

**Architecture:** A `ComputeProvider` interface defines the contract for all compute targets. Host records are stored in the existing SQLite database via new functions in `packages/core/store.ts`. The local provider is the simplest implementation -- no provisioning needed, launches tmux sessions directly, collects metrics via local shell commands. `arc.json` is parsed at dispatch time to resolve ports and sync file declarations.

**Tech Stack:** TypeScript, Bun, `bun:sqlite`, `bun:test`

**Note on test runner:** The project's `package.json` has `"test": "vitest run"` but uses `bun:sqlite` (Bun-specific). All tests in this plan use `bun:test` and are run via `bun test`. If you prefer vitest, change the imports to `import { describe, it, expect } from "vitest"` -- but `bun test` is simpler since Bun is already the runtime.

**Spec:** `docs/superpowers/specs/2026-03-21-compute-layer-design.md`

**Depends on:** Nothing -- this is the foundation plan.

**Followed by:**
- Plan 2: EC2 provider (Pulumi, SSH, cloud-init, sync, cost)
- Plan 3: EC2 observability (metrics, ports, clipboard)
- Plan 4: Docker provider (Pulumi docker, devcontainer, compose)
- Plan 5: Integration (session dispatch, conductor polling, TUI Hosts tab, CLI)

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `packages/compute/types.ts` | ComputeProvider interface, Host type re-export, HostSnapshot, PortDecl, LaunchOpts, SyncOpts |
| `packages/compute/index.ts` | Provider registry (register, resolve), public API re-exports |
| `packages/compute/arc-json.ts` | Parse `arc.json` from a repo directory (ports, sync files, compose/devcontainer flags) |
| `packages/compute/providers/local/index.ts` | LocalProvider implements ComputeProvider |
| `packages/compute/providers/local/metrics.ts` | Local host metrics via shell commands |

### Modified files

| File | Changes |
|------|---------|
| `packages/core/store.ts` | Add `hosts` table to schema, Host interface, host CRUD functions |
| `packages/core/index.ts` | Re-export Host type and host CRUD |
| `tsconfig.json` | Ensure `packages/compute/` is included (already covered by `packages/**/*.ts`) |

### Test files

| File | Tests |
|------|-------|
| `packages/core/__tests__/store-hosts.test.ts` | Host CRUD operations |
| `packages/compute/__tests__/arc-json.test.ts` | arc.json parsing |
| `packages/compute/__tests__/provider-registry.test.ts` | Provider registration and resolution |
| `packages/compute/__tests__/local-provider.test.ts` | LocalProvider behavior |
| `packages/compute/__tests__/local-metrics.test.ts` | Local metrics parsing |

---

## Task 1: Host table and CRUD in store

Add a `hosts` table to the existing SQLite schema and CRUD functions. Follows the exact pattern of the existing session CRUD in `store.ts`.

**Files:**
- Modify: `packages/core/store.ts:26-134` (add Host type after Session, add table to schema, add CRUD after session CRUD)
- Modify: `packages/core/index.ts` (re-export host functions)
- Create: `packages/core/__tests__/store-hosts.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/__tests__/store-hosts.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "bun:test";
import {
  getDb, createHost, getHost, listHosts, updateHost, deleteHost,
  type Host,
} from "../store.js";

beforeEach(() => {
  getDb().run("DELETE FROM hosts");
});

describe("host CRUD", () => {
  it("creates a host with defaults", () => {
    const h = createHost({ name: "dev", provider: "ec2" });
    expect(h.name).toBe("dev");
    expect(h.provider).toBe("ec2");
    expect(h.status).toBe("stopped");
    expect(h.config).toEqual({});
  });

  it("creates a host with full config", () => {
    const h = createHost({
      name: "big-gpu",
      provider: "ec2",
      config: { size: "xl", arch: "x64", region: "us-east-1" },
    });
    expect(h.config).toEqual({ size: "xl", arch: "x64", region: "us-east-1" });
  });

  it("retrieves a host by name", () => {
    createHost({ name: "dev", provider: "local" });
    const h = getHost("dev");
    expect(h).not.toBeNull();
    expect(h!.provider).toBe("local");
  });

  it("returns null for nonexistent host", () => {
    expect(getHost("nope")).toBeNull();
  });

  it("lists all hosts", () => {
    createHost({ name: "a", provider: "ec2" });
    createHost({ name: "b", provider: "local" });
    const all = listHosts();
    expect(all).toHaveLength(2);
    expect(all.map((h) => h.name).sort()).toEqual(["a", "b"]);
  });

  it("filters by provider", () => {
    createHost({ name: "a", provider: "ec2" });
    createHost({ name: "b", provider: "local" });
    expect(listHosts({ provider: "ec2" })).toHaveLength(1);
  });

  it("filters by status", () => {
    createHost({ name: "a", provider: "ec2" });
    createHost({ name: "b", provider: "ec2" });
    updateHost("a", { status: "running" });
    expect(listHosts({ status: "running" })).toHaveLength(1);
  });

  it("updates host fields", () => {
    createHost({ name: "dev", provider: "ec2" });
    updateHost("dev", { status: "running", config: { ip: "1.2.3.4" } });
    const h = getHost("dev")!;
    expect(h.status).toBe("running");
    expect((h.config as any).ip).toBe("1.2.3.4");
  });

  it("deletes a host", () => {
    createHost({ name: "dev", provider: "ec2" });
    expect(deleteHost("dev")).toBe(true);
    expect(getHost("dev")).toBeNull();
  });

  it("returns false deleting nonexistent host", () => {
    expect(deleteHost("nope")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/yana/Projects/ark && bun test packages/core/__tests__/store-hosts.test.ts`
Expected: FAIL -- `createHost` is not exported from `../store.js`

- [ ] **Step 3: Add Host interface to store.ts**

Add after the `Event` interface (after line 61 in `packages/core/store.ts`):

```typescript
export interface Host {
  name: string;              // unique identifier: "dev", "local", "big-gpu"
  provider: string;          // "local" | "docker" | "ec2"
  status: string;            // "stopped" | "running" | "provisioning" | "destroyed"
  config: Record<string, unknown>;  // provider-specific config + runtime state
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 4: Add hosts table to initSchema**

In `packages/core/store.ts`, inside `initSchema()`, add after the sessions/events tables (after line 133):

```sql
    CREATE TABLE IF NOT EXISTS hosts (
      name TEXT PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT 'local',
      status TEXT NOT NULL DEFAULT 'stopped',
      config TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
```

- [ ] **Step 5: Add host CRUD functions**

Add at the end of `packages/core/store.ts`, before the helpers section:

```typescript
// ── Host CRUD ───────────────────────────────────────────────────────────────

export function createHost(opts: {
  name: string;
  provider: string;
  config?: Record<string, unknown>;
}): Host {
  const db = getDb();
  const ts = now();
  db.prepare(`
    INSERT INTO hosts (name, provider, config, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(opts.name, opts.provider, JSON.stringify(opts.config ?? {}), ts, ts);
  return getHost(opts.name)!;
}

export function getHost(name: string): Host | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM hosts WHERE name = ?").get(name) as any;
  if (!row) return null;
  return { ...row, config: JSON.parse(row.config ?? "{}") };
}

export function listHosts(opts?: {
  provider?: string;
  status?: string;
}): Host[] {
  const db = getDb();
  let sql = "SELECT * FROM hosts WHERE 1=1";
  const params: unknown[] = [];
  if (opts?.provider) { sql += " AND provider = ?"; params.push(opts.provider); }
  if (opts?.status) { sql += " AND status = ?"; params.push(opts.status); }
  sql += " ORDER BY name";
  return (db.prepare(sql).all(...params) as any[]).map((r) => ({
    ...r, config: JSON.parse(r.config ?? "{}"),
  }));
}

export function updateHost(name: string, fields: Partial<Host>): Host | null {
  const db = getDb();
  const updates: string[] = ["updated_at = ?"];
  const values: unknown[] = [now()];
  for (const [key, value] of Object.entries(fields)) {
    if (key === "name" || key === "created_at") continue;
    if (key === "config" && typeof value === "object") {
      updates.push("config = ?");
      values.push(JSON.stringify(value));
    } else {
      updates.push(`${key} = ?`);
      values.push(value ?? null);
    }
  }
  values.push(name);
  db.prepare(`UPDATE hosts SET ${updates.join(", ")} WHERE name = ?`).run(...values);
  return getHost(name);
}

export function deleteHost(name: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM hosts WHERE name = ?").run(name);
  return result.changes > 0;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd /Users/yana/Projects/ark && bun test packages/core/__tests__/store-hosts.test.ts`
Expected: ALL PASS

- [ ] **Step 7: Re-export from core index**

Add to `packages/core/index.ts` after the existing Store exports (line 11):

```typescript
// Host
export {
  createHost, getHost, listHosts, updateHost, deleteHost,
  type Host,
} from "./store.js";
```

- [ ] **Step 8: Commit**

```bash
git add packages/core/store.ts packages/core/index.ts packages/core/__tests__/store-hosts.test.ts
git commit -m "feat: add hosts table and CRUD to store"
```

---

## Task 2: ComputeProvider interface and types

Define the provider contract and all shared types for the compute layer.

**Files:**
- Create: `packages/compute/types.ts`

- [ ] **Step 1: Create types.ts**

Create `packages/compute/types.ts`:

```typescript
/**
 * Compute layer types -- provider interface and shared models.
 */

import type { Host, Session } from "../core/store.js";

// Re-export for convenience
export type { Host, Session };

// ── Provider interface ──────────────────────────────────────────────────────

export interface ProvisionOpts {
  /** Override size tier: xs, s, m, l, xl, xxl, xxxl */
  size?: string;
  /** Architecture: x64, arm */
  arch?: string;
  /** Extra tags for the compute resource */
  tags?: Record<string, string>;
}

export interface LaunchOpts {
  /** Tmux session name */
  tmuxName: string;
  /** Working directory on the compute target */
  workdir: string;
  /** Launcher script content */
  launcherContent: string;
  /** Ports to forward (resolved from arc.json + devcontainer.json + compose) */
  ports: PortDecl[];
}

export interface SyncOpts {
  /** Direction of sync */
  direction: "push" | "pull";
  /** Sync only specific categories */
  categories?: string[];
  /** Project-specific files to sync (from arc.json) */
  projectFiles?: string[];
  /** Source directory for project files */
  projectDir?: string;
}

export interface ComputeProvider {
  /** Provider name (e.g., "local", "ec2", "docker") */
  readonly name: string;

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  /** Provision compute resources (no-op for local) */
  provision(host: Host, opts?: ProvisionOpts): Promise<void>;
  /** Destroy compute resources */
  destroy(host: Host): Promise<void>;
  /** Start a stopped compute target */
  start(host: Host): Promise<void>;
  /** Stop a running compute target (preserves state) */
  stop(host: Host): Promise<void>;

  // ── Session execution ─────────────────────────────────────────────────────
  /** Launch a Claude session on this compute target */
  launch(host: Host, session: Session, opts: LaunchOpts): Promise<string>;
  /** Reattach to a running session (re-establish tunnels, attach tmux) */
  attach(host: Host, session: Session): Promise<void>;

  // ── Observability ─────────────────────────────────────────────────────────
  /** Collect current metrics snapshot */
  getMetrics(host: Host): Promise<HostSnapshot>;
  /** Probe whether declared ports have listeners */
  probePorts(host: Host, ports: PortDecl[]): Promise<PortStatus[]>;

  // ── Environment ───────────────────────────────────────────────────────────
  /** Sync credentials and project files to/from the compute target */
  syncEnvironment(host: Host, opts: SyncOpts): Promise<void>;
}

// ── Metrics types ───────────────────────────────────────────────────────────

export interface HostMetrics {
  cpu: number;
  memUsedGb: number;
  memTotalGb: number;
  memPct: number;
  diskPct: number;
  netRxMb: number;
  netTxMb: number;
  uptime: string;
  idleTicks: number;
}

export interface HostSession {
  name: string;
  status: string;   // "working" | "idle"
  mode: string;     // "interactive" | "agentic"
  projectPath: string;
  cpu: number;
  mem: number;
}

export interface HostProcess {
  pid: string;
  cpu: string;
  mem: string;
  command: string;
  workingDir: string;
}

export interface DockerContainer {
  name: string;
  cpu: string;
  memory: string;
  image: string;
  project: string;
}

export interface HostSnapshot {
  metrics: HostMetrics;
  sessions: HostSession[];
  processes: HostProcess[];
  docker: DockerContainer[];
}

// ── Port types ──────────────────────────────────────────────────────────────

export interface PortDecl {
  port: number;
  name?: string;
  source: string;   // "arc.json" | "devcontainer.json" | "docker-compose.yml"
}

export interface PortStatus extends PortDecl {
  listening: boolean;
}

// ── arc.json types ──────────────────────────────────────────────────────────

export interface ArcJson {
  ports?: Array<{ port: number; name?: string }>;
  sync?: string[];
  compose?: boolean;
  devcontainer?: boolean;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd /Users/yana/Projects/ark && bunx tsc --noEmit packages/compute/types.ts`
Expected: No errors (or fix import paths)

- [ ] **Step 3: Commit**

```bash
git add packages/compute/types.ts
git commit -m "feat: define ComputeProvider interface and shared types"
```

---

## Task 3: Provider registry

A simple registry that maps provider names to implementations. Providers register at startup, and the dispatch layer resolves by name.

**Files:**
- Create: `packages/compute/index.ts`
- Create: `packages/compute/__tests__/provider-registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/compute/__tests__/provider-registry.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "bun:test";
import { registerProvider, getProvider, listProviders, clearProviders } from "../index.js";
import type { ComputeProvider } from "../types.js";

const fakeProvider: ComputeProvider = {
  name: "fake",
  provision: async () => {},
  destroy: async () => {},
  start: async () => {},
  stop: async () => {},
  launch: async () => "tmux-name",
  attach: async () => {},
  getMetrics: async () => ({
    metrics: { cpu: 0, memUsedGb: 0, memTotalGb: 0, memPct: 0, diskPct: 0, netRxMb: 0, netTxMb: 0, uptime: "", idleTicks: 0 },
    sessions: [], processes: [], docker: [],
  }),
  probePorts: async () => [],
  syncEnvironment: async () => {},
};

beforeEach(() => clearProviders());

describe("provider registry", () => {
  it("registers and retrieves a provider", () => {
    registerProvider(fakeProvider);
    expect(getProvider("fake")).toBe(fakeProvider);
  });

  it("returns null for unknown provider", () => {
    expect(getProvider("nope")).toBeNull();
  });

  it("lists registered providers", () => {
    registerProvider(fakeProvider);
    registerProvider({ ...fakeProvider, name: "other" });
    expect(listProviders()).toEqual(["fake", "other"]);
  });

  it("overwrites on re-register", () => {
    registerProvider(fakeProvider);
    const updated = { ...fakeProvider };
    registerProvider(updated);
    expect(getProvider("fake")).toBe(updated);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/yana/Projects/ark && bun test packages/compute/__tests__/provider-registry.test.ts`
Expected: FAIL -- module not found

- [ ] **Step 3: Implement the registry**

Create `packages/compute/index.ts`:

```typescript
/**
 * Compute layer -- provider registry and public API.
 */

import type { ComputeProvider } from "./types.js";

// Re-export types
export type {
  ComputeProvider, ProvisionOpts, LaunchOpts, SyncOpts,
  HostSnapshot, HostMetrics, HostSession, HostProcess, DockerContainer,
  PortDecl, PortStatus, ArcJson,
} from "./types.js";

// ── Provider registry ───────────────────────────────────────────────────────

const providers = new Map<string, ComputeProvider>();

export function registerProvider(provider: ComputeProvider): void {
  providers.set(provider.name, provider);
}

export function getProvider(name: string): ComputeProvider | null {
  return providers.get(name) ?? null;
}

export function listProviders(): string[] {
  return [...providers.keys()];
}

export function clearProviders(): void {
  providers.clear();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/yana/Projects/ark && bun test packages/compute/__tests__/provider-registry.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/compute/index.ts packages/compute/__tests__/provider-registry.test.ts
git commit -m "feat: add compute provider registry"
```

---

## Task 4: arc.json parser

Parse the `arc.json` file from a repository directory. Returns port declarations, sync file list, and compose/devcontainer flags.

**Files:**
- Create: `packages/compute/arc-json.ts`
- Create: `packages/compute/__tests__/arc-json.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/compute/__tests__/arc-json.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { parseArcJson, resolvePortDecls } from "../arc-json.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("parseArcJson", () => {
  it("parses a full arc.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "arc-test-"));
    writeFileSync(join(dir, "arc.json"), JSON.stringify({
      ports: [{ port: 3000, name: "web" }, { port: 5432, name: "postgres" }],
      sync: [".env", "terraform.tfvars"],
      compose: true,
      devcontainer: false,
    }));

    const result = parseArcJson(dir);
    expect(result).not.toBeNull();
    expect(result!.ports).toHaveLength(2);
    expect(result!.ports![0].port).toBe(3000);
    expect(result!.sync).toEqual([".env", "terraform.tfvars"]);
    expect(result!.compose).toBe(true);
    expect(result!.devcontainer).toBe(false);

    rmSync(dir, { recursive: true });
  });

  it("returns null when no arc.json exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "arc-test-"));
    expect(parseArcJson(dir)).toBeNull();
    rmSync(dir, { recursive: true });
  });

  it("handles arc.json with only ports", () => {
    const dir = mkdtempSync(join(tmpdir(), "arc-test-"));
    writeFileSync(join(dir, "arc.json"), JSON.stringify({
      ports: [{ port: 8080 }],
    }));

    const result = parseArcJson(dir);
    expect(result!.ports).toHaveLength(1);
    expect(result!.sync).toBeUndefined();

    rmSync(dir, { recursive: true });
  });
});

describe("resolvePortDecls", () => {
  it("converts arc.json ports to PortDecl array", () => {
    const dir = mkdtempSync(join(tmpdir(), "arc-test-"));
    writeFileSync(join(dir, "arc.json"), JSON.stringify({
      ports: [{ port: 3000, name: "web" }],
    }));

    const decls = resolvePortDecls(dir);
    expect(decls).toHaveLength(1);
    expect(decls[0]).toEqual({ port: 3000, name: "web", source: "arc.json" });

    rmSync(dir, { recursive: true });
  });

  it("also reads forwardPorts from devcontainer.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "arc-test-"));
    writeFileSync(join(dir, "arc.json"), JSON.stringify({ ports: [{ port: 3000 }] }));
    const dcDir = join(dir, ".devcontainer");
    mkdirSync(dcDir);
    writeFileSync(join(dcDir, "devcontainer.json"), JSON.stringify({
      forwardPorts: [5432, 6379],
    }));

    const decls = resolvePortDecls(dir);
    expect(decls).toHaveLength(3);
    expect(decls.find((d) => d.port === 5432)?.source).toBe("devcontainer.json");

    rmSync(dir, { recursive: true });
  });

  it("deduplicates ports (arc.json wins)", () => {
    const dir = mkdtempSync(join(tmpdir(), "arc-test-"));
    writeFileSync(join(dir, "arc.json"), JSON.stringify({ ports: [{ port: 3000 }] }));
    const dcDir = join(dir, ".devcontainer");
    mkdirSync(dcDir);
    writeFileSync(join(dcDir, "devcontainer.json"), JSON.stringify({
      forwardPorts: [3000],
    }));

    const decls = resolvePortDecls(dir);
    expect(decls).toHaveLength(1);
    expect(decls[0].source).toBe("arc.json");

    rmSync(dir, { recursive: true });
  });

  it("returns empty array when no config files exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "arc-test-"));
    expect(resolvePortDecls(dir)).toEqual([]);
    rmSync(dir, { recursive: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/yana/Projects/ark && bun test packages/compute/__tests__/arc-json.test.ts`
Expected: FAIL -- module not found

- [ ] **Step 3: Implement arc-json.ts**

Create `packages/compute/arc-json.ts`:

```typescript
/**
 * Parse arc.json and other repo config files for port and sync declarations.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { ArcJson, PortDecl } from "./types.js";

export function parseArcJson(repoDir: string): ArcJson | null {
  const filePath = join(repoDir, "arc.json");
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function parseDevcontainerPorts(repoDir: string): number[] {
  const paths = [
    join(repoDir, ".devcontainer", "devcontainer.json"),
    join(repoDir, ".devcontainer.json"),
  ];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const dc = JSON.parse(readFileSync(p, "utf-8"));
      return Array.isArray(dc.forwardPorts)
        ? dc.forwardPorts.filter((port: unknown) => typeof port === "number")
        : [];
    } catch { /* ignore malformed */ }
  }
  return [];
}

function parseComposePorts(repoDir: string): number[] {
  const paths = [
    join(repoDir, "docker-compose.yml"),
    join(repoDir, "docker-compose.yaml"),
    join(repoDir, "compose.yml"),
    join(repoDir, "compose.yaml"),
  ];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const content = readFileSync(p, "utf-8");
      const ports: number[] = [];
      const matches = content.matchAll(/"?(\d{2,5}):\d{2,5}"?/g);
      for (const m of matches) {
        const port = parseInt(m[1]);
        if (port > 0 && port < 65536) ports.push(port);
      }
      return ports;
    } catch { /* ignore */ }
  }
  return [];
}

export function hasDevcontainer(repoDir: string): boolean {
  return existsSync(join(repoDir, ".devcontainer", "devcontainer.json"))
    || existsSync(join(repoDir, ".devcontainer.json"));
}

export function hasComposeFile(repoDir: string): boolean {
  return ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]
    .some((f) => existsSync(join(repoDir, f)));
}

export function resolvePortDecls(repoDir: string): PortDecl[] {
  const seen = new Set<number>();
  const decls: PortDecl[] = [];

  // arc.json ports take priority
  const arcJson = parseArcJson(repoDir);
  if (arcJson?.ports) {
    for (const p of arcJson.ports) {
      if (!seen.has(p.port)) {
        seen.add(p.port);
        decls.push({ port: p.port, name: p.name, source: "arc.json" });
      }
    }
  }

  // devcontainer.json forwardPorts
  for (const port of parseDevcontainerPorts(repoDir)) {
    if (!seen.has(port)) {
      seen.add(port);
      decls.push({ port, source: "devcontainer.json" });
    }
  }

  // docker-compose ports
  for (const port of parseComposePorts(repoDir)) {
    if (!seen.has(port)) {
      seen.add(port);
      decls.push({ port, source: "docker-compose.yml" });
    }
  }

  return decls;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/yana/Projects/ark && bun test packages/compute/__tests__/arc-json.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Re-export from compute index**

Add to `packages/compute/index.ts`:

```typescript
// arc.json
export { parseArcJson, resolvePortDecls, hasDevcontainer, hasComposeFile } from "./arc-json.js";
```

- [ ] **Step 6: Commit**

```bash
git add packages/compute/arc-json.ts packages/compute/__tests__/arc-json.test.ts packages/compute/index.ts
git commit -m "feat: add arc.json parser with port resolution"
```

---

## Task 5: Local metrics collection

Collect system metrics from the local machine via shell commands. This is the local provider's implementation of `getMetrics()`. Uses `execFileSync` (not `exec`) to avoid shell injection.

**Files:**
- Create: `packages/compute/providers/local/metrics.ts`
- Create: `packages/compute/__tests__/local-metrics.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/compute/__tests__/local-metrics.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { collectLocalMetrics } from "../providers/local/metrics.js";

describe("local metrics", () => {
  it("returns a valid HostSnapshot", async () => {
    const snap = await collectLocalMetrics();

    expect(snap.metrics.cpu).toBeGreaterThanOrEqual(0);
    expect(snap.metrics.cpu).toBeLessThanOrEqual(100);
    expect(snap.metrics.memTotalGb).toBeGreaterThan(0);
    expect(snap.metrics.memUsedGb).toBeGreaterThanOrEqual(0);
    expect(snap.metrics.memPct).toBeGreaterThanOrEqual(0);
    expect(snap.metrics.diskPct).toBeGreaterThan(0);
    expect(snap.metrics.uptime.length).toBeGreaterThan(0);

    expect(Array.isArray(snap.sessions)).toBe(true);
    expect(Array.isArray(snap.processes)).toBe(true);
    expect(Array.isArray(snap.docker)).toBe(true);
  });

  it("session entries have required fields", async () => {
    const snap = await collectLocalMetrics();
    for (const s of snap.sessions) {
      expect(s).toHaveProperty("name");
      expect(s).toHaveProperty("status");
      expect(s).toHaveProperty("mode");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/yana/Projects/ark && bun test packages/compute/__tests__/local-metrics.test.ts`
Expected: FAIL -- module not found

- [ ] **Step 3: Implement local metrics**

Create `packages/compute/providers/local/metrics.ts`:

```typescript
/**
 * Local host metrics collection via shell commands.
 * macOS-compatible (uses vm_stat, sysctl, df, ps, lsof).
 * All commands use execFileSync (no shell injection risk).
 */

import { execFileSync } from "child_process";
import type { HostSnapshot, HostMetrics, HostSession, HostProcess, DockerContainer } from "../../types.js";

function run(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf-8", timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

function getCpu(): number {
  const out = run("top", ["-l", "1", "-n", "0", "-s", "0"]);
  const match = out.match(/CPU usage:\s+([\d.]+)% user,\s+([\d.]+)% sys/);
  if (match) return parseFloat(match[1]) + parseFloat(match[2]);
  return 0;
}

function getMemory(): { usedGb: number; totalGb: number } {
  const totalBytes = parseInt(run("sysctl", ["-n", "hw.memsize"]) || "0");
  const totalGb = totalBytes / (1024 ** 3);

  const vmstat = run("vm_stat", []);
  const pageSizeMatch = vmstat.match(/page size of (\d+) bytes/);
  const ps = pageSizeMatch ? parseInt(pageSizeMatch[1]) : 16384;

  const freeMatch = vmstat.match(/Pages free:\s+(\d+)/);
  const inactiveMatch = vmstat.match(/Pages inactive:\s+(\d+)/);
  const freePages = parseInt(freeMatch?.[1] ?? "0") + parseInt(inactiveMatch?.[1] ?? "0");
  const freeGb = (freePages * ps) / (1024 ** 3);

  return { usedGb: Math.max(0, totalGb - freeGb), totalGb };
}

function getDisk(): number {
  const out = run("df", ["-h", "/"]);
  const match = out.match(/(\d+)%/);
  return match ? parseInt(match[1]) : 0;
}

function getUptime(): string {
  return run("uptime", []).replace(/^.*up\s+/, "up ").replace(/,\s+\d+ user.*$/, "").trim();
}

function getTmuxSessions(): HostSession[] {
  const out = run("tmux", ["list-sessions", "-F", "#{session_name}"]);
  if (!out) return [];

  const sessions: HostSession[] = [];
  for (const name of out.split("\n").filter(Boolean)) {
    let cpu = 0, mem = 0, mode = "interactive", cwd = "";
    try {
      const panePid = run("tmux", ["list-panes", "-t", name, "-F", "#{pane_pid}"]).split("\n")[0];
      cwd = run("tmux", ["display-message", "-t", name, "-p", "#{pane_current_path}"]);
      if (panePid) {
        const psOut = run("ps", ["-p", panePid, "-o", "%cpu=,%mem=,args="]);
        const parts = psOut.trim().split(/\s+/);
        cpu = parseFloat(parts[0] ?? "0") || 0;
        mem = parseFloat(parts[1] ?? "0") || 0;
        if (psOut.includes("dangerously")) mode = "agentic";
      }
    } catch { /* ignore */ }

    sessions.push({
      name,
      status: cpu > 1 ? "working" : "idle",
      mode,
      projectPath: cwd,
      cpu,
      mem,
    });
  }
  return sessions;
}

function getTopProcesses(): HostProcess[] {
  const out = run("ps", ["aux"]);
  if (!out) return [];

  return out.split("\n").slice(1)
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 11) return null;
      const cpu = parseFloat(parts[2]) || 0;
      if (cpu < 0.1) return null;
      return {
        pid: parts[1],
        cpu: `${cpu}%`,
        mem: `${parts[3]}%`,
        command: parts[10],
        workingDir: "",
      } as HostProcess;
    })
    .filter((p): p is HostProcess => p !== null)
    .sort((a, b) => parseFloat(b.cpu) - parseFloat(a.cpu))
    .slice(0, 8);
}

function getDockerContainers(): DockerContainer[] {
  const stats = run("docker", ["stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"]);
  if (!stats) return [];

  const ps = run("docker", ["ps", "--format", "{{.Names}}\t{{.Image}}"]);
  const imageMap: Record<string, string> = {};
  for (const line of ps.split("\n").filter(Boolean)) {
    const [name, image] = line.split("\t");
    if (name && image) imageMap[name] = image;
  }

  return stats.split("\n").filter(Boolean).map((line) => {
    const [name, cpu, memory] = line.split("\t");
    const image = imageMap[name ?? ""] ?? "";
    return {
      name: name ?? "",
      cpu: cpu?.trim() ?? "",
      memory: memory?.trim() ?? "",
      image: image.includes("/") ? image.split("/").pop()! : image,
      project: name ?? "",
    };
  });
}

export async function collectLocalMetrics(): Promise<HostSnapshot> {
  const mem = getMemory();
  const metrics: HostMetrics = {
    cpu: getCpu(),
    memUsedGb: mem.usedGb,
    memTotalGb: mem.totalGb,
    memPct: mem.totalGb > 0 ? (mem.usedGb / mem.totalGb) * 100 : 0,
    diskPct: getDisk(),
    netRxMb: 0,
    netTxMb: 0,
    uptime: getUptime(),
    idleTicks: 0,
  };

  return {
    metrics,
    sessions: getTmuxSessions(),
    processes: getTopProcesses(),
    docker: getDockerContainers(),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/yana/Projects/ark && bun test packages/compute/__tests__/local-metrics.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/compute/providers/local/metrics.ts packages/compute/__tests__/local-metrics.test.ts
git commit -m "feat: add local host metrics collection"
```

---

## Task 6: LocalProvider implementation

The local provider -- simplest ComputeProvider. No provisioning, launches tmux sessions directly, delegates to existing `packages/core/tmux.ts`. Uses `execFileSync` for port probing.

**Files:**
- Create: `packages/compute/providers/local/index.ts`
- Create: `packages/compute/__tests__/local-provider.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/compute/__tests__/local-provider.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { LocalProvider } from "../providers/local/index.js";
import type { Host, Session } from "../../core/store.js";

const provider = new LocalProvider();

const fakeHost: Host = {
  name: "local",
  provider: "local",
  status: "running",
  config: {},
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

describe("LocalProvider", () => {
  it("has name 'local'", () => {
    expect(provider.name).toBe("local");
  });

  it("provision is a no-op", async () => {
    await provider.provision(fakeHost);
  });

  it("destroy is a no-op", async () => {
    await provider.destroy(fakeHost);
  });

  it("start is a no-op", async () => {
    await provider.start(fakeHost);
  });

  it("stop is a no-op", async () => {
    await provider.stop(fakeHost);
  });

  it("getMetrics returns a valid snapshot", async () => {
    const snap = await provider.getMetrics(fakeHost);
    expect(snap.metrics.cpu).toBeGreaterThanOrEqual(0);
    expect(snap.metrics.memTotalGb).toBeGreaterThan(0);
    expect(Array.isArray(snap.sessions)).toBe(true);
  });

  it("probePorts returns status for each port", async () => {
    const result = await provider.probePorts(fakeHost, [
      { port: 99999, source: "test" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].port).toBe(99999);
    expect(result[0].listening).toBe(false);
  });

  it("syncEnvironment is a no-op", async () => {
    await provider.syncEnvironment(fakeHost, { direction: "push" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/yana/Projects/ark && bun test packages/compute/__tests__/local-provider.test.ts`
Expected: FAIL -- module not found

- [ ] **Step 3: Implement LocalProvider**

Create `packages/compute/providers/local/index.ts`:

```typescript
/**
 * Local compute provider -- runs sessions on the local machine.
 * No provisioning needed. Uses existing tmux module for session management.
 */

import { execFileSync } from "child_process";
import type {
  ComputeProvider, ProvisionOpts, LaunchOpts, SyncOpts,
  HostSnapshot, PortDecl, PortStatus,
} from "../../types.js";
import type { Host, Session } from "../../../core/store.js";
import * as tmux from "../../../core/tmux.js";
import { collectLocalMetrics } from "./metrics.js";

export class LocalProvider implements ComputeProvider {
  readonly name = "local";

  async provision(_host: Host, _opts?: ProvisionOpts): Promise<void> {}

  async destroy(_host: Host): Promise<void> {}

  async start(_host: Host): Promise<void> {}

  async stop(_host: Host): Promise<void> {}

  async launch(_host: Host, _session: Session, opts: LaunchOpts): Promise<string> {
    const launcher = tmux.writeLauncher(opts.tmuxName, opts.launcherContent);
    tmux.createSession(opts.tmuxName, `bash ${launcher}`);
    return opts.tmuxName;
  }

  async attach(_host: Host, _session: Session): Promise<void> {
    // Local attach: no tunnels needed, tmux attach handled by CLI layer
  }

  async getMetrics(_host: Host): Promise<HostSnapshot> {
    return collectLocalMetrics();
  }

  async probePorts(_host: Host, ports: PortDecl[]): Promise<PortStatus[]> {
    return ports.map((decl) => {
      let listening = false;
      try {
        const out = execFileSync("lsof", ["-i", `:${decl.port}`, "-sTCP:LISTEN"], {
          encoding: "utf-8", timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"],
        });
        listening = out.trim().length > 0;
      } catch { /* not listening */ }
      return { ...decl, listening };
    });
  }

  async syncEnvironment(_host: Host, _opts: SyncOpts): Promise<void> {
    // No-op: local machine shares the filesystem
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/yana/Projects/ark && bun test packages/compute/__tests__/local-provider.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Register local provider in compute index**

Add to `packages/compute/index.ts`:

```typescript
// Providers
import { LocalProvider } from "./providers/local/index.js";
export { LocalProvider };

// Auto-register local provider
registerProvider(new LocalProvider());
```

- [ ] **Step 6: Commit**

```bash
git add packages/compute/providers/local/index.ts packages/compute/__tests__/local-provider.test.ts packages/compute/index.ts
git commit -m "feat: add LocalProvider with metrics and port probing"
```

---

## Task 7: Run all tests, verify everything works together

**Files:** None new -- verification only.

- [ ] **Step 1: Install dependencies**

Run: `cd /Users/yana/Projects/ark && bun install`

- [ ] **Step 2: Run full test suite**

Run: `cd /Users/yana/Projects/ark && bun test`
Expected: ALL PASS across all test files:
- `packages/core/__tests__/store-hosts.test.ts`
- `packages/compute/__tests__/provider-registry.test.ts`
- `packages/compute/__tests__/arc-json.test.ts`
- `packages/compute/__tests__/local-metrics.test.ts`
- `packages/compute/__tests__/local-provider.test.ts`

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd /Users/yana/Projects/ark && bunx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit any fixes**

If any test or type issues were found and fixed:
```bash
git add -A && git commit -m "fix: resolve test/type issues in compute foundation"
```

---

## Summary

| Task | What | New/Modified | Tests |
|------|------|-------------|-------|
| 1 | Host table + CRUD | `store.ts`, `index.ts` | 10 tests |
| 2 | Provider interface + types | `compute/types.ts` | compile check |
| 3 | Provider registry | `compute/index.ts` | 4 tests |
| 4 | arc.json parser | `compute/arc-json.ts` | 7 tests |
| 5 | Local metrics | `compute/providers/local/metrics.ts` | 2 tests |
| 6 | LocalProvider | `compute/providers/local/index.ts` | 7 tests |
| 7 | Integration verification | -- | full suite |

After this plan, the compute foundation is in place:
- Provider interface defined
- Provider registry working
- Host CRUD in SQLite
- Local provider operational with metrics
- arc.json parsing with multi-source port resolution
- Ready for EC2 provider (Plan 2), Docker provider (Plan 4), and integration (Plan 5)
