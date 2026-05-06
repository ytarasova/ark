# Compute Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the half-done two-axis compute migration in one PR: delete the legacy `providers/` hierarchy, drop the legacy `provider` DB column, kill `arc.json`, erase the phantom `firecracker-in-container` isolation kind, inline the over-engineered flag-spec registry, and fold `packages/compute/` and `packages/workspace/` back under `packages/core/`.

**Architecture:** Eight sequential internal milestones, each leaving the build green. Together they collapse two parallel provider hierarchies into one (the `Compute` + `Isolation` two-axis model), unify per-repo config under the existing `.ark.yaml` (no more `arc.json`), and remove every "fictional" boundary (the cyclic `compute`↔`core` import, the `compute_templates.provider` column, the dual-registry boot, the phantom isolation kind).

**Tech Stack:** TypeScript (`strict: false`, ES modules with `.js` extensions), Bun runtime + `bun:test`, Drizzle ORM with hand-wrapped migrations (dual-dialect SQLite + Postgres), Commander.js CLI, tmux. Per CLAUDE.md: Prettier 120-col / double quotes, ESLint zero warnings, `make format && make lint && make test` before every commit, never use em dashes.

**Source spec:** `docs/superpowers/specs/2026-05-05-compute-cleanup-design.md`

---

## Prerequisites Check

Before starting, confirm:

1. **Working directory clean.** `git status` shows no uncommitted changes (other than this plan, if you just wrote it). The unstaged `packages/arkd/client/client.ts` from the prior session needs to be either committed or stashed first.
2. **On a fresh branch off `main`.** `git switch -c refactor/compute-cleanup main`. The spec commits (`14852cf1`, `df00d3dd`) currently sit on `refactor/arkd-separation`; cherry-pick them onto the new branch before starting: `git cherry-pick 14852cf1 df00d3dd`.
3. **CI green on `main`.** `make test` passes locally before touching anything.
4. **Database backed up if non-empty.** `cp ~/.ark/ark.db ~/.ark/ark.db.bak.cleanup` (Task 5 runs a destructive schema migration).

---

## File Structure (target end-state)

This is what `packages/` looks like when the plan is complete. Use it as the north star while working through tasks.

```
packages/
  arkd/                       # unchanged
  cli/                        # unchanged structure; one file modified (compute/create.ts)
  core/
    compute/                  # NEW HOME -- was packages/compute/
      types.ts                # Compute, Isolation, ComputeHandle, AgentHandle (only contract)
      compute-target.ts
      local.ts
      ec2/
        compute.ts            # EC2Compute (was core/ec2.ts + post-launch-op absorption)
        provision.ts          # was providers/ec2/provision.ts
        ssm.ts                # was providers/ec2/ssm.ts
        cloud-init.ts
        cost.ts
        ports.ts
        clipboard.ts
        metrics.ts
        placement-ctx.ts
        pool.ts
        queue.ts
        remote-setup.ts
        shell-escape.ts
        sync.ts
        aws-creds.ts
        constants.ts
        retry.ts              # absorbed from old packages/compute/util.ts
      k8s.ts                  # K8sCompute
      k8s-kata.ts             # KataCompute
      firecracker/            # FirecrackerCompute + supporting files (unchanged contents)
      pool/
      snapshot-store.ts
      snapshot-store-fs.ts
      workspace-clone.ts
      isolation/
        direct.ts
        docker.ts             # absorbs container-lifecycle from LocalDockerProvider
        docker-compose.ts     # reads docker-compose.yml directly, no arc.json
        devcontainer.ts       # reads devcontainer.json directly, no arc.json
        types.ts              # was docker-config.ts
      index.ts                # exports only the new-world surface
    workspace/                # NEW HOME -- was packages/workspace/
      index.ts
      manifest.ts
      provisioner.ts
      store.ts
      types.ts
      __tests__/
    ...                       # everything else in core/ unchanged
  desktop/                    # unchanged
  e2e/                        # unchanged (test imports updated)
  protocol/                   # unchanged
  router/                     # unchanged
  server/                     # unchanged structure; ~5 handler files modified
  types/                      # unchanged
  web/                        # unchanged structure; import paths updated
```

**Files DELETED entirely:**
- `packages/compute/arc-json.ts`
- `packages/compute/types.ts` (old `ComputeProvider` interface)
- `packages/compute/util.ts` (helpers folded into `core/compute/ec2/retry.ts`)
- `packages/compute/flag-spec.ts` (singular)
- `packages/compute/flag-specs/` (entire directory)
- `packages/compute/adapters/` (both `legacy.ts` and `provider-map.ts`)
- `packages/compute/providers/` (entire directory: `arkd-backed.ts`, `local-arkd.ts`, `remote-arkd.ts`, `k8s.ts`, all `*-placement-ctx.ts`)
- `packages/compute/__tests__/arc-json.test.ts`, `arc-json-compose.test.ts`
- `packages/compute/__tests__/legacy-adapter.test.ts`
- `packages/compute/__tests__/provider-map.test.ts`
- `packages/workspace/package.json`, `packages/workspace/tsconfig.json`

**Top-level `packages/` shrinks by two: `compute/` and `workspace/` are gone.**

---

## Task 0: Branch setup

**Files:**
- None modified; pure git plumbing.

- [ ] **Step 1: Verify clean working tree**

```bash
git status
```

Expected: `On branch main` (or whichever clean branch you intend to base off), `nothing to commit, working tree clean`. If `packages/arkd/client/client.ts` is still showing modified from the prior session, decide with the user whether to commit, stash, or discard before continuing.

- [ ] **Step 2: Create the cleanup branch from `main`**

```bash
git switch main
git pull --ff-only origin main
git switch -c refactor/compute-cleanup main
```

- [ ] **Step 3: Cherry-pick the spec commits**

```bash
git cherry-pick 14852cf1 df00d3dd
```

Expected: clean cherry-pick (the only files touched by those commits are under `docs/superpowers/specs/`, no conflicts possible from later code commits).

- [ ] **Step 4: Verify build is green on the new branch**

```bash
make format && make lint && make test
```

Expected: all green. If anything is red on `main` itself, stop and report — do not start the cleanup on a broken base.

- [ ] **Step 5: Backup the local DB**

```bash
[ -f ~/.ark/ark.db ] && cp ~/.ark/ark.db ~/.ark/ark.db.bak.cleanup-$(date +%Y%m%d-%H%M%S) || echo "no local DB to back up"
```

---

## Task 1: Move `packages/compute/` and `packages/workspace/` under `packages/core/`

**Files:**
- Move: `packages/compute/**` → `packages/core/compute/**`
- Move: `packages/workspace/**` → `packages/core/workspace/**`
- Delete: `packages/workspace/package.json`, `packages/workspace/tsconfig.json`
- Modify: every file that imports `from "../compute/..."`, `from "../../compute/..."`, `from "../workspace/..."`, etc. — across `cli/`, `server/`, `web/`, `types/`, `arkd/`, `e2e/`. Internal `core/` imports become local relative paths.

- [ ] **Step 1: Move the directories with `git mv`**

```bash
git mv packages/compute packages/core/compute
git mv packages/workspace packages/core/workspace
```

- [ ] **Step 2: Delete `workspace/package.json` and `workspace/tsconfig.json`**

```bash
rm packages/core/workspace/package.json packages/core/workspace/tsconfig.json
```

- [ ] **Step 3: Find and rewrite every import path**

The relative-import depth changes for any file outside `core/`. Use this single-shot sed pass to rewrite the four most common patterns (run from repo root):

```bash
# External consumers (cli/, server/, web/, types/, arkd/, e2e/) used "../compute/" or "../../compute/"
# These now resolve via "../core/compute/" or "../../core/compute/"
find packages/cli packages/server packages/web packages/types packages/arkd packages/e2e packages/desktop packages/protocol packages/router -type f \( -name "*.ts" -o -name "*.tsx" \) -print0 | \
  xargs -0 sed -i '' \
    -e 's|from "\(\.\./\)*compute/|from "\1core/compute/|g' \
    -e 's|from "\(\.\./\)*workspace/|from "\1core/workspace/|g'
```

Note: the BSD `sed -i ''` form is correct on macOS (per the host OS in environment).

- [ ] **Step 4: Fix `core/` internal imports that previously used the cross-package shape**

`packages/core/` files that imported `from "../compute/..."` (i.e. up out of `core/` and into the sibling `compute/`) now need to become local relative paths inside the new `core/compute/` home, OR be rewritten to `from "./compute/..."`. The sed above handles `../compute/` → `../core/compute/` only for files OUTSIDE `core/`, so for files INSIDE `packages/core/`, run:

```bash
find packages/core -type f \( -name "*.ts" -o -name "*.tsx" \) -not -path "*/core/compute/*" -not -path "*/core/workspace/*" -print0 | \
  xargs -0 sed -i '' \
    -e 's|from "\.\./compute/|from "./compute/|g' \
    -e 's|from "\.\./\.\./compute/|from "../compute/|g' \
    -e 's|from "\.\./workspace/|from "./workspace/|g' \
    -e 's|from "\.\./\.\./workspace/|from "../workspace/|g'
```

- [ ] **Step 5: Fix INSIDE-`core/compute/` self-imports that used to come back through the package boundary**

Files inside the new `packages/core/compute/` that previously imported from sibling `core/` packages (observability, secrets, AppContext) used `../core/...`. Those were one-up-out into the cross-package world; now they need to go up out of `compute/` and back across `core/` siblings:

```bash
find packages/core/compute -type f \( -name "*.ts" -o -name "*.tsx" \) -print0 | \
  xargs -0 sed -i '' \
    -e 's|from "\.\./core/|from "../|g'
```

(The `from "../core/observability/..."` shape becomes `from "../observability/..."` because we're now inside `packages/core/compute/` looking up to `packages/core/observability/`.)

- [ ] **Step 6: Run typecheck to find any remaining broken imports**

```bash
make lint 2>&1 | head -100
```

Expected: there will likely be a handful of leftovers the sed pass missed (e.g. dynamic `await import("../compute/...")` strings, paths using single quotes, paths split across template-literal boundaries). Hand-fix each one. Re-run until `make lint` is clean of import errors.

- [ ] **Step 7: Verify the build is fully green**

```bash
make format && make lint && make test
```

Expected: all green. If `make test` fails on tests that hardcoded the old `packages/compute/` path in fixtures, fix those too.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(compute): fold packages/compute and packages/workspace under packages/core

Both packages had no real boundary (no package.json, cyclic imports back to
core). Moving them under core/ removes the fiction. Workspace was promoted
out of core/ on 2026-05-05; this reverts that.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Delete `arc-json.ts`; collapse port discovery into the isolation layer

**Files:**
- Modify: `packages/core/compute/isolation/devcontainer.ts` — read `devcontainer.json` directly via JSONC parser
- Modify: `packages/core/compute/isolation/docker-compose.ts` — read `docker-compose.yml` directly via existing YAML parser
- Modify: `packages/core/executors/claude-code.ts` (lines 15, 138, 378) — replace `parseArcJson` calls with isolation-layer port helpers
- Modify: `packages/core/executors/goose.ts` (lines 127, 129) — same
- Modify: `packages/core/compute/isolation/docker-compose.ts` (lines 27, 127, 128, 132) — drop the arc-json indirection
- Modify: `packages/core/compute/providers/docker/compose.ts` (line 12) — drop the `COMPOSE_FILE_NAMES` import (this file is being deleted in Task 4 but still has to type-check at this step)
- Modify: `packages/core/compute/types.ts` — drop `ArcJson`, `ArcComposeConfig`, `ArcDevcontainerConfig` types
- Modify: `packages/core/compute/index.ts` — drop the arc-json exports (`parseArcJson`, `normalizeArcJson`, `resolveArcCompose`, `COMPOSE_FILE_NAMES`, `ArcJson`, etc.)
- Delete: `packages/core/compute/arc-json.ts`
- Delete: `packages/core/compute/__tests__/arc-json.test.ts`
- Delete: `packages/core/compute/__tests__/arc-json-compose.test.ts`
- Modify: any test fixture files (`e2e.test.ts`, `e2e-compute.test.ts`, `docker-compose-runtime.test.ts`) that still write `arc.json` files — switch to `docker-compose.yml` / `devcontainer.json` directly

- [ ] **Step 1: Add a port-discovery helper in `isolation/devcontainer.ts`**

The current `arc-json.ts:resolvePortDecls` reads `devcontainer.json` and pulls `forwardPorts`. Move that logic to a new exported function in `packages/core/compute/isolation/devcontainer.ts`:

```ts
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import stripJsonComments from "strip-json-comments";

export interface PortDecl {
  port: number;
  protocol?: "tcp" | "udp";
  label?: string;
}

/**
 * Read forwardPorts from .devcontainer/devcontainer.json (or root devcontainer.json).
 * Returns empty array if no devcontainer config is present.
 */
export function discoverDevcontainerPorts(workdir: string): PortDecl[] {
  for (const candidate of [".devcontainer/devcontainer.json", "devcontainer.json"]) {
    const path = join(workdir, candidate);
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(stripJsonComments(raw));
      const ports = Array.isArray(parsed.forwardPorts) ? parsed.forwardPorts : [];
      return ports
        .filter((p: unknown) => typeof p === "number" && Number.isInteger(p))
        .map((p: number) => ({ port: p }));
    } catch {
      return [];
    }
  }
  return [];
}
```

- [ ] **Step 2: Add a port-discovery helper in `isolation/docker-compose.ts`**

Move `arc-json.ts`'s compose port-discovery into `packages/core/compute/isolation/docker-compose.ts`. The compose file uses YAML; reuse the existing `yaml` package already in deps:

```ts
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import type { PortDecl } from "./devcontainer.js";

const COMPOSE_FILE_NAMES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];

/** Locate the compose file in workdir; null if none. */
export function findComposeFile(workdir: string): string | null {
  for (const name of COMPOSE_FILE_NAMES) {
    const path = join(workdir, name);
    if (existsSync(path)) return path;
  }
  return null;
}

/** Read service-level `ports:` from a compose file. Returns empty array on parse error or no compose file. */
export function discoverComposePorts(workdir: string): PortDecl[] {
  const path = findComposeFile(workdir);
  if (!path) return [];
  try {
    const parsed = YAML.parse(readFileSync(path, "utf-8"));
    const services = parsed?.services ?? {};
    const out: PortDecl[] = [];
    for (const svc of Object.values(services as Record<string, any>)) {
      const ports = Array.isArray(svc?.ports) ? svc.ports : [];
      for (const entry of ports) {
        const port = parseComposePort(entry);
        if (port !== null) out.push({ port });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function parseComposePort(entry: unknown): number | null {
  if (typeof entry === "number") return Number.isInteger(entry) ? entry : null;
  if (typeof entry === "string") {
    // "3000", "3000:3000", "127.0.0.1:3000:3000", "3000/tcp"
    const m = entry.match(/(\d+)(?:\/[a-z]+)?$/);
    return m ? parseInt(m[1]!, 10) : null;
  }
  if (typeof entry === "object" && entry && "target" in entry) {
    const t = (entry as any).target;
    return typeof t === "number" ? t : null;
  }
  return null;
}
```

- [ ] **Step 3: Add a unifying helper in `isolation/index.ts` (or create one) that callers use**

Most callers want "all ports for this workdir, regardless of which file they came from." Add to wherever the existing isolation index lives (or create `packages/core/compute/isolation/ports.ts`):

```ts
import { discoverDevcontainerPorts, type PortDecl } from "./devcontainer.js";
import { discoverComposePorts } from "./docker-compose.js";

/** Merge ports from devcontainer.json + docker-compose.yml; dedupe by port number. */
export function discoverWorkspacePorts(workdir: string): PortDecl[] {
  const all = [...discoverDevcontainerPorts(workdir), ...discoverComposePorts(workdir)];
  const seen = new Set<number>();
  return all.filter((p) => {
    if (seen.has(p.port)) return false;
    seen.add(p.port);
    return true;
  });
}

export type { PortDecl } from "./devcontainer.js";
```

- [ ] **Step 4: Write tests for the new helpers**

Create `packages/core/compute/isolation/__tests__/ports.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { discoverDevcontainerPorts, discoverComposePorts, discoverWorkspacePorts } from "../ports.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ports-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("discoverDevcontainerPorts", () => {
  it("reads forwardPorts from .devcontainer/devcontainer.json", () => {
    mkdirSync(join(tmp, ".devcontainer"));
    writeFileSync(
      join(tmp, ".devcontainer/devcontainer.json"),
      JSON.stringify({ forwardPorts: [3000, 8080] }),
    );
    expect(discoverDevcontainerPorts(tmp)).toEqual([{ port: 3000 }, { port: 8080 }]);
  });
  it("strips JSONC comments", () => {
    writeFileSync(
      join(tmp, "devcontainer.json"),
      `{ /* comment */ "forwardPorts": [4000] }`,
    );
    expect(discoverDevcontainerPorts(tmp)).toEqual([{ port: 4000 }]);
  });
  it("returns empty array when no devcontainer file present", () => {
    expect(discoverDevcontainerPorts(tmp)).toEqual([]);
  });
});

describe("discoverComposePorts", () => {
  it("reads service-level ports from docker-compose.yml", () => {
    writeFileSync(
      join(tmp, "docker-compose.yml"),
      `services:\n  web:\n    ports:\n      - "3000:3000"\n      - 8080\n`,
    );
    expect(discoverComposePorts(tmp)).toEqual([{ port: 3000 }, { port: 8080 }]);
  });
  it("returns empty array when no compose file present", () => {
    expect(discoverComposePorts(tmp)).toEqual([]);
  });
});

describe("discoverWorkspacePorts", () => {
  it("merges and dedupes across both formats", () => {
    mkdirSync(join(tmp, ".devcontainer"));
    writeFileSync(join(tmp, ".devcontainer/devcontainer.json"), JSON.stringify({ forwardPorts: [3000, 4000] }));
    writeFileSync(join(tmp, "docker-compose.yml"), `services:\n  web:\n    ports:\n      - 3000\n      - 5000\n`);
    expect(discoverWorkspacePorts(tmp).map((p) => p.port).sort()).toEqual([3000, 4000, 5000]);
  });
});
```

- [ ] **Step 5: Run the new tests to verify they pass**

```bash
make test-file F=packages/core/compute/isolation/__tests__/ports.test.ts
```

Expected: all 7 tests pass.

- [ ] **Step 6: Update `executors/claude-code.ts` and `executors/goose.ts` to use the new helper**

In `packages/core/executors/claude-code.ts`:
- Remove the import at line 15: `import { parseArcJson } from "../compute/arc-json.js";`
- Remove the dynamic import at line 378: `const { resolvePortDecls } = await import("../compute/arc-json.js");`
- Replace `parseArcJson(workdir)` with calls that fetch what's actually needed. The old `arcJson` object was used to read `arcJson.ports` and to detect compose/devcontainer presence. Replace with:
  - For ports: `import { discoverWorkspacePorts } from "../compute/isolation/ports.js"` and call `discoverWorkspacePorts(effectiveWorkdir)`.
  - For compose presence: `import { findComposeFile } from "../compute/isolation/docker-compose.js"`; `findComposeFile(workdir) !== null`.
  - For devcontainer presence: `existsSync(join(workdir, ".devcontainer/devcontainer.json")) || existsSync(join(workdir, "devcontainer.json"))`.

In `packages/core/executors/goose.ts` (lines 127-129): same substitution. The dynamic `await import` pattern can become a static top-level import now that arc-json is gone.

- [ ] **Step 7: Update `isolation/docker-compose.ts` to read compose directly**

The current file (`packages/core/compute/isolation/docker-compose.ts:27, 127-132`) calls `parseArcJson` to find compose config. Replace with the new `findComposeFile()` helper plus a direct `YAML.parse` for any `inline` config (which was an arc.json feature — drop it; if compose isn't already a file in the repo, the user just doesn't get compose isolation). Update `DockerComposeIsolation.prepare()` to:

```ts
import { findComposeFile } from "./docker-compose.js"; // self-import is fine; or extract findComposeFile to a shared helper

async prepare(handle, opts) {
  const composeFile = findComposeFile(opts.workdir);
  if (!composeFile) {
    throw new Error(`docker-compose isolation requires a compose file in workdir; none found in ${opts.workdir}`);
  }
  // ... existing logic, using composeFile path directly
}
```

- [ ] **Step 8: Update `isolation/devcontainer.ts` similarly**

The current devcontainer isolation likely also reaches through arc-json to find devcontainer.json. Make it read the file directly with the standard JSONC strip pattern. Drop the `arc.devcontainer.config` indirection — if a `.devcontainer/devcontainer.json` exists in the workdir, use it; otherwise `prepare()` throws.

- [ ] **Step 9: Update `packages/core/compute/types.ts` to drop ArcJson types**

Search for `ArcJson`, `ArcComposeConfig`, `ArcDevcontainerConfig` and delete the type definitions. Verify nothing remaining imports them.

- [ ] **Step 10: Update `packages/core/compute/index.ts` to drop arc-json exports**

Remove these exports:
```ts
export { parseArcJson, resolvePortDecls, hasDevcontainer, hasComposeFile } from "./arc-json.js";
export { parseArcJson, normalizeArcJson, resolveArcCompose, DEFAULT_COMPOSE_FILE } from "./arc-json.js";
// Type re-exports for ArcJson, ArcComposeConfig, ArcDevcontainerConfig
```

- [ ] **Step 11: Delete `arc-json.ts` and its tests**

```bash
git rm packages/core/compute/arc-json.ts
git rm packages/core/compute/__tests__/arc-json.test.ts
git rm packages/core/compute/__tests__/arc-json-compose.test.ts
```

- [ ] **Step 12: Update `providers/docker/compose.ts` (still exists, deleted in Task 4) to drop the `COMPOSE_FILE_NAMES` import**

This file is going away in Task 4 but must compile in the meantime. Inline the constant: `const COMPOSE_FILE_NAMES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];` directly in the file.

- [ ] **Step 13: Search for any remaining test fixtures that write `arc.json`**

```bash
grep -rln "arc\.json\|arcJson\|parseArcJson\|ArcJson" packages/core/compute/__tests__/ packages/core/__tests__/ packages/server/__tests__/
```

For each hit, rewrite the fixture: instead of `writeFileSync(workdir + "/arc.json", JSON.stringify({ ports: [...] }))`, either (a) write a `.devcontainer/devcontainer.json` with `forwardPorts`, or (b) write a `docker-compose.yml` with `services.web.ports`, depending on which path the test exercises.

- [ ] **Step 14: Verify the build is fully green**

```bash
make format && make lint && make test
```

Expected: all green. If `make test` surfaces a test that depended on `arc.json`'s `sync` field (the explicit sync globs), the test should be updated to use `.ark.yaml`'s `worktree.copy` instead — that's the documented replacement.

- [ ] **Step 15: Verify nothing references arc.json anywhere**

```bash
grep -rn "arc\.json\|arcJson\|parseArcJson\|ArcJson\|normalizeArcJson\|resolveArcCompose" packages/ --include="*.ts" --include="*.tsx" --include="*.yaml" --include="*.json"
```

Expected: zero hits in `packages/`. (Hits in `docs/` are fine — those are historical and covered by issue #515.)

- [ ] **Step 16: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(compute): delete arc.json; move port discovery into isolation layer

The arc.json per-repo config duplicated .ark.yaml. Each former arc.json
field now sources from what already exists: sync from .ark.yaml worktree.copy,
compose/devcontainer auto-detected from file presence, ports auto-discovered
from devcontainer.json forwardPorts and docker-compose.yml service ports.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Add post-launch ops to `AgentHandle` and `ComputeHandle`

**Files:**
- Modify: `packages/core/compute/types.ts` (the `Compute`, `Isolation`, `ComputeHandle`, `AgentHandle` interfaces)
- Modify: each new-world `Compute` impl: `local.ts`, `ec2/compute.ts`, `k8s.ts`, `k8s-kata.ts`, `firecracker/compute.ts` — add `getMetrics(handle)` impls
- Modify: each new-world `Isolation` impl: `direct.ts`, `docker.ts`, `docker-compose.ts`, `devcontainer.ts` — `launchAgent` returns an `AgentHandle` with `kill`, `captureOutput`, `checkAlive`
- Modify: `packages/server/handlers/resource-compute.ts` — replace `getProvider(providerOf(compute))` calls with `ComputeTarget` paths
- Modify: any other server handler / CLI command that calls the legacy `ComputeProvider.killAgent / captureOutput / checkSession / getMetrics`
- Test: `packages/core/compute/__tests__/post-launch-ops.test.ts` — new test file

This is the only task where genuinely new functionality (interface methods) lands. TDD applies.

- [ ] **Step 1: Write the failing test for `AgentHandle.kill()`**

Create `packages/core/compute/__tests__/post-launch-ops.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext, setApp, clearApp } from "../../app.js";

let app: AppContext;
beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
});
afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

describe("AgentHandle.kill()", () => {
  it("kills a launched agent on a local+direct target", async () => {
    const target = app.resolveComputeTarget({ compute_kind: "local", isolation_kind: "direct" } as any);
    const computeHandle = await target.compute.provision({});
    await target.isolation.prepare(computeHandle, {});
    const agentHandle = await target.isolation.launchAgent(computeHandle, {
      script: "#!/bin/sh\nsleep 30",
      sessionName: "test-kill",
      workdir: "/tmp",
    });
    expect(agentHandle.kill).toBeDefined();
    await agentHandle.kill();
    const alive = await agentHandle.checkAlive();
    expect(alive).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
make test-file F=packages/core/compute/__tests__/post-launch-ops.test.ts
```

Expected: FAIL because `agentHandle.kill` is undefined (the method doesn't exist on the interface yet).

- [ ] **Step 3: Add the four post-launch methods to the `AgentHandle` interface**

In `packages/core/compute/types.ts`, find the `AgentHandle` interface and add:

```ts
export interface AgentHandle {
  // ... existing fields (agentId, etc.)

  /** Terminate the agent process. Idempotent. */
  kill(): Promise<void>;

  /** Capture the agent's tmux pane output. Returns the pane contents as a string. */
  captureOutput(): Promise<string>;

  /** Check whether the agent process is still alive. */
  checkAlive(): Promise<boolean>;
}
```

Add `getMetrics()` to `ComputeHandle`:

```ts
export interface ComputeMetrics {
  cpuPercent: number | null;
  memoryUsedMB: number | null;
  memoryTotalMB: number | null;
  diskUsedMB: number | null;
  diskTotalMB: number | null;
}

export interface ComputeHandle {
  // ... existing fields

  /** Pull instantaneous resource metrics for the compute. May return nulls if unavailable. */
  getMetrics(): Promise<ComputeMetrics>;
}
```

- [ ] **Step 4: Implement the methods on each new-world `Isolation`**

For each of `direct.ts`, `docker.ts`, `docker-compose.ts`, `devcontainer.ts`, change `launchAgent()` to return an object that implements the new methods. Since all four currently delegate to arkd via `client.launchAgent(...)`, they all use the same `ArkdClient` that the compute exposes. Pattern (in `direct.ts`):

```ts
async launchAgent(computeHandle, opts): Promise<AgentHandle> {
  const arkdUrl = this.compute.getArkdUrl(computeHandle);
  const client = new ArkdClient(arkdUrl);
  const launchResp = await client.launchAgent(opts);
  const agentId = launchResp.agentId;

  return {
    agentId,
    sessionName: opts.sessionName,
    async kill() {
      await client.killAgent(agentId);
    },
    async captureOutput() {
      return client.captureOutput(agentId);
    },
    async checkAlive() {
      const status = await client.checkSession(agentId).catch(() => ({ alive: false }));
      return status.alive ?? false;
    },
  };
}
```

Apply the same pattern to the other three isolations. They differ only in how `compute.getArkdUrl` resolves (containerized vs. direct), which the compute already handles transparently.

- [ ] **Step 5: Implement `getMetrics()` on each new-world `Compute`**

For each of `local.ts`, `ec2/compute.ts`, `k8s.ts`, `k8s-kata.ts`, `firecracker/compute.ts`, add a method that calls arkd's metrics endpoint and shapes the response:

```ts
async getMetrics(handle): Promise<ComputeMetrics> {
  const client = new ArkdClient(this.getArkdUrl(handle));
  const raw = await client.getMetrics().catch(() => null);
  if (!raw) return { cpuPercent: null, memoryUsedMB: null, memoryTotalMB: null, diskUsedMB: null, diskTotalMB: null };
  return {
    cpuPercent: raw.cpu ?? null,
    memoryUsedMB: raw.mem_used_mb ?? null,
    memoryTotalMB: raw.mem_total_mb ?? null,
    diskUsedMB: raw.disk_used_mb ?? null,
    diskTotalMB: raw.disk_total_mb ?? null,
  };
}
```

The shape of `raw` is whatever arkd's existing `/metrics` endpoint returns; check `packages/arkd/server/...` for the exact field names. If arkd doesn't have a metrics endpoint yet, this is OUT OF SCOPE for this PR — file an issue (or extend arkd in a follow-up) and stub `getMetrics()` to return all-nulls for now.

- [ ] **Step 6: Run the test from step 1 to verify it now passes**

```bash
make test-file F=packages/core/compute/__tests__/post-launch-ops.test.ts
```

Expected: PASS.

- [ ] **Step 7: Add tests for `captureOutput`, `checkAlive`, and `getMetrics`**

Extend the test file with three more `it(...)` blocks following the same pattern. Each should provision-prepare-launch, then call the new method, then assert on the result. Use the local+direct target so tests don't depend on cloud creds.

- [ ] **Step 8: Run the full new-test file**

```bash
make test-file F=packages/core/compute/__tests__/post-launch-ops.test.ts
```

Expected: 4 passing tests.

- [ ] **Step 9: Sweep server handler call sites that use the legacy provider for post-launch ops**

```bash
grep -rn "getProvider(providerOf\|provider\.killAgent\|provider\.captureOutput\|provider\.checkSession\|provider\.getMetrics" packages/server/ packages/core/ packages/cli/
```

For each hit, replace the legacy lookup with the `ComputeTarget` path. Pattern:

Before:
```ts
const provider = app.getProvider(providerOf(compute));
await provider.killAgent(handle);
```

After:
```ts
const target = await app.resolveComputeTarget(session);
const agentHandle = /* rehydrate from session.config.agent_handle, see existing pattern */;
await agentHandle.kill();
```

The rehydration shape depends on how the handler currently receives the session/handle context. In `packages/server/handlers/resource-compute.ts`, the handler likely already has the `Compute` row and reads `session.config.agent_handle`; just route through `ComputeTarget` instead of `getProvider`.

- [ ] **Step 10: Verify the build is fully green**

```bash
make format && make lint && make test
```

Expected: all green. The legacy registry STILL exists at this point (it's deleted in Task 4) but no production caller of `killAgent / captureOutput / checkSession / getMetrics` should be using it anymore.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(compute): post-launch ops on AgentHandle and ComputeHandle

Adds kill/captureOutput/checkAlive on AgentHandle and getMetrics on
ComputeHandle so ComputeTarget covers the full session lifecycle, not
just launch. Sweeps server handlers and CLI off the legacy
getProvider(providerOf(compute)) path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Delete the `providers/` directory and the old `ComputeProvider` interface

**Files:**
- Modify: `packages/core/infra/compute-providers-boot.ts` — remove the legacy registry registrations (`app.registerProvider(...)`)
- Delete: `packages/core/compute/providers/` (entire directory: `arkd-backed.ts`, `local-arkd.ts`, `remote-arkd.ts`, `k8s.ts`, `k8s-placement-ctx.ts`, `firecracker-placement-ctx.ts`, `docker-placement-ctx.ts`, `local-placement-ctx.ts`)
- Move (don't delete): `packages/core/compute/providers/ec2/*` → `packages/core/compute/ec2/` siblings (these are helpers consumed by `EC2Compute`, not provider classes)
- Move: `packages/core/compute/providers/docker/*` → `packages/core/compute/isolation/` (helpers consumed by docker-compose / devcontainer isolations)
- Delete: `packages/core/compute/types.ts` (the OLD `ComputeProvider` interface — but keep the new types in `packages/core/compute/core/types.ts`)

Wait: there's a name collision. The new types live in `core/compute/core/types.ts` (deeply nested). The old types live in `core/compute/types.ts`. After we delete the old, we should consider promoting the new to the top: `core/compute/core/types.ts` → `core/compute/types.ts`. Decided: yes, do that as part of this task to avoid the awkward `core/compute/core/` triple-nesting.

- [ ] **Step 1: Move EC2 helpers out of `providers/ec2/` into `core/compute/ec2/`**

The `core/compute/ec2/` directory was created in Task 1 (it's where `EC2Compute` lives). The helpers under `providers/ec2/` (`provision.ts`, `ssm.ts`, `cloud-init.ts`, `cost.ts`, `ports.ts`, `clipboard.ts`, `metrics.ts`, `pool.ts`, `queue.ts`, `remote-setup.ts`, `shell-escape.ts`, `sync.ts`, `aws-creds.ts`, `constants.ts`, `placement-ctx.ts`) need to live next to `EC2Compute`:

```bash
git mv packages/core/compute/providers/ec2/*.ts packages/core/compute/ec2/
```

Update the imports inside the moved files: any `from "../arc-json.js"` (already deleted) must be gone; any `from "../../core/types.js"` becomes `from "../types.js"` (after the types promotion in Step 4 below).

- [ ] **Step 2: Move docker helpers out of `providers/docker/` into `core/compute/isolation/`**

The compose / devcontainer / helper files under `providers/docker/` are consumed by the `Isolation` implementations. Move them next to their consumers:

```bash
git mv packages/core/compute/providers/docker/compose.ts packages/core/compute/isolation/compose-helpers.ts
git mv packages/core/compute/providers/docker/devcontainer.ts packages/core/compute/isolation/devcontainer-helpers.ts
git mv packages/core/compute/providers/docker/devcontainer-resolve.ts packages/core/compute/isolation/devcontainer-resolve.ts
git mv packages/core/compute/providers/docker/helpers.ts packages/core/compute/isolation/docker-helpers.ts
```

Update imports inside each moved file (`from "../../arc-json.js"` is already gone after Task 2; rewrite remaining `from "../..."` paths to match the new location).

- [ ] **Step 3: Delete the now-empty provider classes**

```bash
git rm packages/core/compute/providers/arkd-backed.ts
git rm packages/core/compute/providers/local-arkd.ts
git rm packages/core/compute/providers/remote-arkd.ts
git rm packages/core/compute/providers/k8s.ts
git rm packages/core/compute/providers/local-placement-ctx.ts
git rm packages/core/compute/providers/k8s-placement-ctx.ts
git rm packages/core/compute/providers/firecracker-placement-ctx.ts
git rm packages/core/compute/providers/docker-placement-ctx.ts
git rm -r packages/core/compute/providers/
```

The `providers/` directory should now be entirely empty and removed.

- [ ] **Step 4: Promote `core/compute/core/types.ts` to `core/compute/types.ts`**

The old `core/compute/types.ts` (with `ComputeProvider`) is being deleted; the new types currently live nested at `core/compute/core/types.ts`. Promote them:

```bash
git rm packages/core/compute/types.ts                              # old ComputeProvider gone
git mv packages/core/compute/core/types.ts packages/core/compute/types.ts
```

Also promote the rest of `core/compute/core/` up by one level (the deep nesting was an artifact of the old `core/` subfolder convention):

```bash
git mv packages/core/compute/core/compute-target.ts packages/core/compute/compute-target.ts
git mv packages/core/compute/core/local.ts packages/core/compute/local.ts
git mv packages/core/compute/core/ec2.ts packages/core/compute/ec2/compute.ts  # merge into the ec2 subfolder
# Note: if EC2Compute is already in ec2/compute.ts after Task 1's setup, skip the line above.
git mv packages/core/compute/core/k8s.ts packages/core/compute/k8s.ts
git mv packages/core/compute/core/k8s-kata.ts packages/core/compute/k8s-kata.ts
git mv packages/core/compute/core/firecracker packages/core/compute/firecracker
git mv packages/core/compute/core/pool packages/core/compute/pool
git mv packages/core/compute/core/snapshot-store.ts packages/core/compute/snapshot-store.ts
git mv packages/core/compute/core/snapshot-store-fs.ts packages/core/compute/snapshot-store-fs.ts
git mv packages/core/compute/core/workspace-clone.ts packages/core/compute/workspace-clone.ts
rmdir packages/core/compute/core
```

- [ ] **Step 5: Sweep imports across the codebase to drop the deep `core/` segment**

```bash
find packages/ -type f \( -name "*.ts" -o -name "*.tsx" \) -print0 | \
  xargs -0 sed -i '' \
    -e 's|packages/core/compute/core/|packages/core/compute/|g' \
    -e 's|"\(\.\./\)*compute/core/|"\1compute/|g'
```

(The first sed handles string-literal paths in tests/fixtures; the second handles import paths.)

- [ ] **Step 6: Drop the legacy registry from `ComputeProvidersBoot`**

In `packages/core/infra/compute-providers-boot.ts`, find every `app.registerProvider(...)` call and delete it. Keep `app.registerCompute(...)` and `app.registerIsolation(...)` calls (these are the new-world registrations).

Also check `packages/core/app.ts` for the `registerProvider` / `getProvider` methods — if Task 5 hasn't deleted them yet, they're still present but unused; leave them for now and Task 5 sweeps them.

- [ ] **Step 7: Update `packages/core/compute/index.ts` to drop legacy exports**

Remove every export that referred to the deleted classes:
- `LocalWorktreeProvider`, `LocalDockerProvider`, `LocalDevcontainerProvider`, `LocalFirecrackerProvider`
- `RemoteWorktreeProvider`, `RemoteDockerProvider`, `RemoteDevcontainerProvider`, `RemoteFirecrackerProvider`
- `K8sProvider`, `KataProvider` (the old ones — keep `K8sCompute`, `KataCompute`)
- `ArkdBackedProvider`
- `ComputeProvider` interface (and any associated option types)
- `LaunchOpts`, `SyncOpts`, `ComputeSnapshot`, `PortDecl` — verify each: if it's used by the new world, keep; if it's an old-world type, drop.

- [ ] **Step 8: Verify the build is fully green**

```bash
make format && make lint && make test
```

Expected: all green. If `make test` reveals tests that referenced the deleted provider classes (e.g. `LocalWorktreeProvider`), delete or rewrite those tests — they're testing dead code.

- [ ] **Step 9: Verify zero references to old types**

```bash
grep -rn "ComputeProvider\b\|LocalWorktreeProvider\|RemoteWorktreeProvider\|ArkdBackedProvider" packages/ --include="*.ts"
```

Expected: zero hits.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(compute): delete providers/ directory; the new two-axis world is the only contract

Removes the parallel old hierarchy (arkd-backed Local*Provider / Remote*Provider /
K8sProvider / KataProvider, all four placement-ctx files, the legacy
ComputeProvider interface). Helpers under providers/ec2 and providers/docker
move to live next to their consumers (compute/ec2/ siblings and isolation/).
Promotes compute/core/* up one level to flatten the awkward triple-nesting.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Drop the legacy `provider` column; sweep all `providerOf` callers

**Files:**
- Create: `packages/core/migrations/010_drop_legacy_provider_columns.ts`
- Modify: `packages/core/drizzle/schema/sqlite.ts` (lines 97, 109, 124, 371-372, 450, 502)
- Modify: `packages/core/drizzle/schema/postgres.ts` (matching locations)
- Generate: `packages/core/drizzle/sqlite/00NN_*.sql` and `packages/core/drizzle/postgres/00NN_*.sql` via `drizzle-kit generate`
- Modify: `packages/core/repositories/compute.ts` (lines 13, 66, 153, 185, 228, 233 — anywhere it touches the `provider` column or imports from `provider-map`)
- Modify: `packages/core/repositories/compute-template.ts` (lines 24, 105 — same)
- Modify: every other importer of `from "../../compute/adapters/provider-map.js"` and `from "../../../compute/adapters/provider-map.js"` — see Task 5's grep at the start
- Delete: `packages/core/compute/adapters/legacy.ts`
- Delete: `packages/core/compute/adapters/provider-map.ts`
- Delete: `packages/core/compute/adapters/` (now-empty directory)
- Delete: `packages/core/compute/__tests__/legacy-adapter.test.ts`
- Delete: `packages/core/compute/__tests__/provider-map.test.ts`
- Modify: `packages/cli/commands/compute/create.ts` — replace `--provider` with `--kind` + `--isolation`
- Modify: `packages/core/app.ts` — remove `registerProvider`/`getProvider` methods (now unused after Task 4)

- [ ] **Step 1: Edit the drizzle schema files**

In `packages/core/drizzle/schema/sqlite.ts`:
- Line 97: delete `provider: text("provider").notNull().default("local"),`
- Line 109-110: delete `idxProvider: index("idx_compute_provider").on(t.provider),`
- Line 124: delete the `provider` column on `compute_templates`
- Lines 371-372: delete `allowedProviders` and `defaultProvider` columns on the hosted policy table (or wherever those live — verify by reading the surrounding context; if they're a different concept than the legacy provider column, leave them)
- Line 450 and 502: delete the `provider` columns on the `hosted_*` tables

Apply the same edits to `packages/core/drizzle/schema/postgres.ts`. Re-read both files after edits to confirm no stragglers.

- [ ] **Step 2: Generate the SQL migration files**

Per CLAUDE.md migrations workflow:

```bash
bun x drizzle-kit generate --config drizzle.config.ts
DRIZZLE_DIALECT=postgres bun x drizzle-kit generate --config drizzle.config.ts
```

Expected: two new SQL files appear under `packages/core/drizzle/sqlite/` and `packages/core/drizzle/postgres/` containing the `ALTER TABLE ... DROP COLUMN` statements.

- [ ] **Step 3: Write the migration wrapper `010_drop_legacy_provider_columns.ts`**

Create `packages/core/migrations/010_drop_legacy_provider_columns.ts`. It wraps the generated SQL plus the firecracker data fixup:

```ts
import type { MigrationFn } from "./types.js";
import { readFileSync } from "fs";
import { join } from "path";

export const migration: MigrationFn = {
  id: "010_drop_legacy_provider_columns",
  description: "Drop legacy provider column from compute, compute_templates, hosted_* tables; coerce phantom firecracker-in-container isolation kind",
  up: async ({ db, dialect }) => {
    // Data fixup BEFORE dropping the column (so we can still query by old values)
    await db.execute(`UPDATE compute SET compute_kind = 'firecracker', isolation_kind = 'direct' WHERE compute_kind = 'local' AND isolation_kind = 'firecracker-in-container'`);
    await db.execute(`UPDATE compute_templates SET compute_kind = 'firecracker', isolation_kind = 'direct' WHERE compute_kind = 'local' AND isolation_kind = 'firecracker-in-container'`);

    // Apply the generated DDL
    const sqlPath = dialect === "sqlite"
      ? join(import.meta.dir, "../drizzle/sqlite/00NN_drop_provider.sql")  // replace 00NN with the actual generated number
      : join(import.meta.dir, "../drizzle/postgres/00NN_drop_provider.sql");
    const sql = readFileSync(sqlPath, "utf-8");
    for (const stmt of sql.split(/;\s*$/m).filter((s) => s.trim())) {
      await db.execute(stmt);
    }
  },
};
```

Look at one of the existing 010+ migration files (the drizzle-kit-cutover marker migration `009_*` or `010_*`) for the exact wrapper conventions. The pattern is: register in `packages/core/migrations/index.ts` (or wherever migrations are registered).

- [ ] **Step 4: Verify drift gate passes**

```bash
make drift
```

Expected: green. If it complains, the schema TS and the generated SQL are out of sync — fix by regenerating.

- [ ] **Step 5: Sweep `providerOf`, `pairToProvider`, `providerToPair` callers**

```bash
grep -rln "providerOf\|providerToPair\|pairToProvider\|isKnownProvider\|knownProviders" packages/ --include="*.ts"
```

For each file, replace the call:
- `providerOf(compute)` returns the legacy string. Anywhere this fed into `app.getProvider(...)`, the call site is dead after Task 4 — delete it. Anywhere it fed into UI display ("Provider: docker"), use `${compute.compute_kind}/${compute.isolation_kind}` instead.
- `providerToPair(name)` — direct replacement is "the row already has compute_kind + isolation_kind, just use those." Delete the call.
- `pairToProvider(pair)` — same, delete.

In `packages/core/repositories/compute.ts`:
- Line 13: delete the import.
- Line 66: delete the fallback path. The DB row has `compute_kind` and `isolation_kind` directly; no derivation needed.
- Lines 123-124 (the `set.provider` write in INSERT): delete entirely.
- Lines 153, 185, 228, 233: any filter / write of `provider` is gone.

In `packages/core/repositories/compute-template.ts` (lines 24, 105): same shape.

- [ ] **Step 6: Update the CLI: replace `--provider` with `--kind` + `--isolation`**

In `packages/cli/commands/compute/create.ts`:
- Remove the `--provider <provider>` option.
- Add `--kind <kind>` (one of: `local`, `ec2`, `k8s`, `k8s-kata`, `firecracker`).
- Add `--isolation <isolation>` (one of: `direct`, `docker`, `docker-compose`, `devcontainer`).
- Remove the import of `providerOf` (line 7).
- Remove the dynamic-import branch at line 144 that uses `providerToPair` / `pairToProvider`.
- The remaining per-provider option flags (`--image`, `--aws-region`, etc.) stay — they're inlined in Task 6.

In any place that called `providerOf(compute)` for display (CLI table outputs, error messages), replace with `${compute.compute_kind}+${compute.isolation_kind}` or just `compute.compute_kind` depending on what reads better.

- [ ] **Step 7: Delete the adapters directory**

```bash
git rm packages/core/compute/adapters/legacy.ts
git rm packages/core/compute/adapters/provider-map.ts
git rm -r packages/core/compute/adapters
git rm packages/core/compute/__tests__/legacy-adapter.test.ts
git rm packages/core/compute/__tests__/provider-map.test.ts
```

- [ ] **Step 8: Drop `registerProvider` / `getProvider` from `AppContext`**

In `packages/core/app.ts`, find the methods `registerProvider`, `getProvider`, `listProviders`, `_providers` registry. Delete all of them — Task 4 already removed every caller.

- [ ] **Step 9: Update `packages/core/compute/index.ts`**

Remove the `adapters/*` re-exports:
```ts
export { providerToPair, pairToProvider, isKnownProvider, knownProviders } from "./adapters/provider-map.js";
export type { ComputeIsolationPair } from "./adapters/provider-map.js";
export { computeProviderToTarget } from "./adapters/legacy.js";
```

- [ ] **Step 10: Verify migration runs cleanly on a fresh DB**

```bash
rm ~/.ark/ark.db
bun ark daemon &
sleep 3
kill %1
sqlite3 ~/.ark/ark.db "SELECT name FROM pragma_table_info('compute') WHERE name = 'provider';"
```

Expected: empty output (the `provider` column is gone).

- [ ] **Step 11: Verify the build is fully green**

```bash
make format && make lint && make test
```

Expected: all green. Test files that referenced the legacy column (e.g. `expect(row.provider).toBe(...)`) need to be rewritten to assert on `compute_kind` / `isolation_kind`.

- [ ] **Step 12: Verify zero references**

```bash
grep -rn "providerOf\|providerToPair\|pairToProvider\|registerProvider\|getProvider\|knownProviders\|isKnownProvider" packages/ --include="*.ts" | grep -v "__tests__/.*\.snap"
```

Expected: zero hits in production code. Hits in test snapshots that get regenerated next run are OK.

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(compute): drop legacy provider column; remove adapters/ entirely

Migration 010 drops the provider column from compute, compute_templates, and
the hosted_* tables, plus coerces phantom isolation_kind=firecracker-in-container
rows to compute_kind=firecracker + isolation_kind=direct. Sweeps ~30 callers of
providerOf/providerToPair/pairToProvider. Replaces the CLI --provider flag with
--kind + --isolation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Inline flag-specs into the CLI; delete the registry

**Files:**
- Modify: `packages/cli/commands/compute/create.ts` — inline ~15 options + `configFromFlags` + `displaySummary` switch
- Delete: `packages/core/compute/flag-spec.ts`
- Delete: `packages/core/compute/flag-specs/` (entire directory)

- [ ] **Step 1: Read the existing `flag-specs/` files to gather every option**

```bash
cat packages/core/compute/flag-specs/{local,docker,ec2,k8s,firecracker}.ts
```

Capture:
- Every `option` entry: flag, description, default
- Every `configFromFlags` body
- Every `displaySummary` body

- [ ] **Step 2: Inline the options into `packages/cli/commands/compute/create.ts`**

Replace the `for (const spec of allFlagSpecs())` loop that registers options with direct `cmd.option(...)` calls. Group by kind for readability:

```ts
cmd
  // Common
  .option("--kind <kind>", "Compute kind: local, ec2, k8s, k8s-kata, firecracker", "local")
  .option("--isolation <isolation>", "Isolation: direct, docker, docker-compose, devcontainer", "direct")

  // Docker
  .option("--image <image>", "Docker image (default: ubuntu:22.04)")
  .option("--devcontainer", "Use devcontainer.json from project")
  .option("--volume <mount>", "Extra volume mount (repeatable)", collect, [] as string[])

  // EC2
  .option("--size <size>", "Instance size: xs, s, m, l, xl, xxl, xxxl", "m")
  .option("--arch <arch>", "Architecture: x64, arm", "x64")
  .option("--aws-region <region>", "AWS region", "us-east-1")
  .option("--aws-profile <profile>", "AWS profile")
  .option("--aws-subnet-id <id>", "AWS subnet ID")
  .option("--aws-tag <key=value>", "AWS tag (repeatable)", collect, [] as string[])

  // K8s
  .option("--context <context>", "K8s context")
  .option("--namespace <namespace>", "K8s namespace", "ark")
  .option("--k8s-image <image>", "K8s pod image", "ghcr.io/ytarasova/ark:latest")
  // ... (any other k8s options from the original spec)
```

Where `collect` is the standard Commander accumulator: `const collect = (val: string, prev: string[]) => [...prev, val];`

- [ ] **Step 3: Inline `configFromFlags` as a switch on `--kind`**

In the same file:

```ts
function configFromFlags(kind: string, opts: Record<string, any>): Record<string, unknown> {
  switch (kind) {
    case "local":
      return {};
    case "docker":
      return {
        image: opts.image ?? "ubuntu:22.04",
        ...(opts.devcontainer ? { devcontainer: true } : {}),
        ...(opts.volume?.length ? { volumes: opts.volume } : {}),
      };
    case "ec2": {
      const tags = parseTags(opts.awsTag);
      return {
        size: opts.size,
        arch: opts.arch,
        region: opts.awsRegion,
        ...(opts.awsProfile ? { aws_profile: opts.awsProfile } : {}),
        ...(opts.awsSubnetId ? { subnet_id: opts.awsSubnetId } : {}),
        ...(Object.keys(tags).length ? { tags } : {}),
      };
    }
    case "k8s":
    case "k8s-kata":
      return {
        context: opts.context,
        namespace: opts.namespace,
        image: opts.k8sImage,
      };
    case "firecracker":
      // Read packages/core/compute/flag-specs/firecracker.ts BEFORE deleting it in Step 7 and
      // paste its configFromFlags body here verbatim. The shape is the same as the others:
      // pull whichever opts.* fields the firecracker spec named, return them as a config object.
      return { /* paste from flag-specs/firecracker.ts:configFromFlags */ };
    default:
      return {};
  }
}

function parseTags(raw: unknown): Record<string, string> {
  if (!Array.isArray(raw)) return {};
  const tags: Record<string, string> = {};
  for (const entry of raw as unknown[]) {
    if (typeof entry !== "string") continue;
    const [k, ...rest] = entry.split("=");
    if (k && rest.length) tags[k] = rest.join("=");
  }
  return tags;
}
```

- [ ] **Step 4: Inline `displaySummary` similarly**

```ts
function displaySummary(kind: string, config: Record<string, any>, opts: Record<string, any>): string[] {
  switch (kind) {
    case "docker": {
      const lines = [`  Image:    ${config.image ?? "ubuntu:22.04"}`];
      if (config.devcontainer) lines.push(`  Devcontainer: yes`);
      if (config.volumes?.length) lines.push(`  Volumes:  ${config.volumes.join(", ")}`);
      return lines;
    }
    case "ec2": {
      // pull INSTANCE_SIZES if needed; import from the new location
      return [
        `  Size:     ${config.size ?? ""}`,
        `  Arch:     ${config.arch ?? ""}`,
        `  Region:   ${config.region ?? ""}`,
      ];
    }
    case "k8s":
    case "k8s-kata":
      return [
        `  Context:   ${config.context ?? ""}`,
        `  Namespace: ${config.namespace ?? ""}`,
        `  Image:     ${config.image ?? ""}`,
      ];
    case "firecracker":
      // Same instruction as configFromFlags above: copy the body of
      // packages/core/compute/flag-specs/firecracker.ts:displaySummary verbatim before
      // deleting that file. If displaySummary in firecracker.ts returned an empty array,
      // return [] here too.
      return [/* paste from flag-specs/firecracker.ts:displaySummary */];
    default:
      return [];
  }
}
```

- [ ] **Step 5: Replace the call sites in `create.ts`**

Where the file used `getFlagSpec(provider).configFromFlags(opts)`, replace with `configFromFlags(opts.kind, opts)`. Where it used `getFlagSpec(provider).displaySummary(config, opts)`, replace with `displaySummary(opts.kind, config, opts)`.

- [ ] **Step 6: Drop the imports of `allFlagSpecs` / `getFlagSpec` / `ProviderFlagOption`**

In `packages/cli/commands/compute/create.ts`:
```ts
// DELETE these:
import { allFlagSpecs, getFlagSpec } from "../../../core/compute/index.js";
import type { ProviderFlagOption } from "../../../core/compute/index.js";
```

- [ ] **Step 7: Delete the registry and types**

```bash
git rm -r packages/core/compute/flag-specs
git rm packages/core/compute/flag-spec.ts
```

- [ ] **Step 8: Update `packages/core/compute/index.ts` to drop flag-spec exports**

Remove:
```ts
export { allFlagSpecs, getFlagSpec, flagSpecRegistry } from "./flag-specs/index.js";
export type { ProviderFlagSpec, ProviderFlagOption } from "./flag-spec.js";
```

- [ ] **Step 9: Verify the CLI still works end-to-end**

```bash
./ark compute create --kind local --isolation direct --name test-local
./ark compute list
./ark compute delete test-local
```

Expected: each command prints its expected output, no errors.

- [ ] **Step 10: Verify the build is fully green**

```bash
make format && make lint && make test
```

Expected: all green.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(compute): inline flag definitions in CLI; delete flag-specs registry

The polymorphic flag-spec abstraction (interface + Map + 6 files) generated
~15 CLI options for a fixed set of 5 providers. Inlining them in
cli/commands/compute/create.ts removes the ceremony.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Erase the phantom `firecracker-in-container` isolation kind from the codebase

**Files:**
- Modify: `packages/core/compute/types.ts` (or wherever `IsolationKind` union is defined) — remove `"firecracker-in-container"` from the union
- Modify: any switch/lookup in TypeScript that names the value
- Verify: data fixup ran in Task 5

- [ ] **Step 1: Find the `IsolationKind` union definition**

```bash
grep -rn "IsolationKind\b" packages/ --include="*.ts" | head -20
```

Locate the `export type IsolationKind = ...` line. Remove `"firecracker-in-container"` from the union.

- [ ] **Step 2: Find every literal use**

```bash
grep -rn "firecracker-in-container" packages/ --include="*.ts" --include="*.tsx" --include="*.yaml"
```

For each hit, delete or rewrite. Most should already be gone after Task 4 (which deleted `LocalFirecrackerProvider`) and Task 5 (which deleted `provider-map.ts`). Anything remaining in switches, defaults, or test fixtures should be removed.

- [ ] **Step 3: Verify zero hits**

```bash
grep -rn "firecracker-in-container" packages/ docs/superpowers/specs/ docs/superpowers/plans/ --include="*.ts" --include="*.tsx" --include="*.yaml" --include="*.md"
```

Expected: hits ONLY in this plan file and the spec file (since they document the deletion). Zero hits in `packages/` source.

- [ ] **Step 4: Verify the build is fully green**

```bash
make format && make lint && make test
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(compute): erase phantom firecracker-in-container isolation kind

The kind appeared in provider-map (deleted in Task 5) and in the IsolationKind
union but had no Isolation implementation registered. Firecracker is now
exclusively FirecrackerCompute + DirectIsolation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Final pass — index.ts, util.ts, doc-comment scrub

**Files:**
- Modify: `packages/core/compute/index.ts` — final clean export list
- Modify: `packages/core/compute/ec2/retry.ts` (new) — absorbs old `util.ts` helpers
- Delete: `packages/core/compute/util.ts`
- Modify: any source file whose JSDoc still references deleted modules

- [ ] **Step 1: Read the current state of `packages/core/compute/index.ts`**

```bash
cat packages/core/compute/index.ts
```

Confirm what's still being exported. The target final shape is:

```ts
// types
export type { Compute, Isolation, ComputeHandle, AgentHandle, ComputeMetrics, ComputeKind, IsolationKind } from "./types.js";
export { NotSupportedError } from "./types.js";

// computes
export { LocalCompute } from "./local.js";
export { EC2Compute } from "./ec2/compute.js";
export type { EC2HandleMeta, EC2ProvisionConfig, EC2ComputeHelpers } from "./ec2/compute.js";
export { K8sCompute } from "./k8s.js";
export type { K8sComputeConfig, K8sHandleMeta, K8sComputeDeps } from "./k8s.js";
export { KataCompute, DEFAULT_KATA_RUNTIME_CLASS } from "./k8s-kata.js";
export { FirecrackerCompute, registerFirecrackerIfAvailable } from "./firecracker/compute.js";
export type { FirecrackerComputeDeps, FirecrackerMeta } from "./firecracker/compute.js";

// isolations
export { DirectIsolation } from "./isolation/direct.js";
export { DockerIsolation } from "./isolation/docker.js";
export { DockerComposeIsolation } from "./isolation/docker-compose.js";
export { DevcontainerIsolation } from "./isolation/devcontainer.js";
export type { DockerConfig } from "./isolation/types.js";

// composer
export { ComputeTarget } from "./compute-target.js";

// snapshot store
export type { SnapshotStore, SnapshotRef, SnapshotBlob, SnapshotListFilter } from "./snapshot-store.js";
export { SnapshotNotFoundError } from "./snapshot-store.js";
export { FsSnapshotStore } from "./snapshot-store-fs.js";

// pool
export type { ComputePool, PoolConfig, PoolStats } from "./pool/types.js";
export { defaultPoolConfig } from "./pool/types.js";
export { LocalFirecrackerPool } from "./pool/local-firecracker-pool.js";

// port discovery
export { discoverWorkspacePorts, discoverDevcontainerPorts, discoverComposePorts, findComposeFile } from "./isolation/ports.js";
export type { PortDecl } from "./isolation/devcontainer.js";

// helpers
export { cloneWorkspaceViaArkd } from "./workspace-clone.js";
```

Edit the file to match. Delete any remaining old-world re-export.

- [ ] **Step 2: Move `util.ts` helpers into `ec2/retry.ts`**

```bash
cat packages/core/compute/util.ts
```

If the helpers are `pRetry` and `pWaitFor` thin wrappers, create `packages/core/compute/ec2/retry.ts` with the same exports. Update every importer (which after Task 4 should be only files inside `packages/core/compute/ec2/` and possibly `providers/remote-arkd.ts` — but that's deleted now). Search:

```bash
grep -rn "from \".*compute/util" packages/ --include="*.ts"
```

For each importer, change `from "../util.js"` (or whatever) to `from "./retry.js"` if same dir, or appropriate relative path.

```bash
git mv packages/core/compute/util.ts packages/core/compute/ec2/retry.ts
```

- [ ] **Step 3: Scrub doc comments referencing dead modules**

```bash
grep -rn "arc-json\|ArcJson\|ComputeProvider\|providerOf\|providerToPair\|adapters/legacy\|adapters/provider-map\|firecracker-in-container" packages/ --include="*.ts" -l
```

Each remaining hit will be in JSDoc / inline comments. Open the file, rewrite the comment to either describe the new state, delete it, or note the cleanup happened (e.g. "previously routed through the legacy provider; now uses ComputeTarget").

- [ ] **Step 4: Verify the build is fully green**

```bash
make format && make lint && make test
```

Expected: all green.

- [ ] **Step 5: Final verification pass — every grep should be zero**

```bash
echo "=== arc.json residue ===" && grep -rn "arc\.json\|arcJson\|parseArcJson\|ArcJson\|normalizeArcJson\|resolveArcCompose" packages/ --include="*.ts" --include="*.tsx" --include="*.yaml"
echo "=== legacy provider plumbing ===" && grep -rn "ComputeProvider\b\|providerOf\b\|providerToPair\b\|pairToProvider\b\|registerProvider\b\|getProvider\b" packages/ --include="*.ts"
echo "=== legacy provider classes ===" && grep -rn "LocalWorktreeProvider\|RemoteWorktreeProvider\|ArkdBackedProvider\|LocalDockerProvider\|LocalDevcontainerProvider\|LocalFirecrackerProvider\|RemoteDockerProvider\|RemoteDevcontainerProvider\|RemoteFirecrackerProvider\|K8sProvider\b\|KataProvider\b" packages/ --include="*.ts"
echo "=== phantom kind ===" && grep -rn "firecracker-in-container" packages/ --include="*.ts" --include="*.yaml"
echo "=== flag-spec registry ===" && grep -rn "allFlagSpecs\|getFlagSpec\|flagSpecRegistry\|ProviderFlagSpec\|ProviderFlagOption" packages/ --include="*.ts"
echo "=== old packages/compute path ===" && grep -rn "packages/compute\|packages/workspace" packages/ --include="*.ts" --include="*.tsx" | grep -v "packages/core/compute\|packages/core/workspace"
```

Expected: zero hits across all six categories.

- [ ] **Step 6: Confirm top-level `packages/` shrank**

```bash
ls packages/
```

Expected: `arkd cli core desktop e2e protocol router server test-setup.ts types web`. No `compute/`, no `workspace/`.

- [ ] **Step 7: Run the full test suite one final time**

```bash
make format && make lint && make test
```

Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(compute): final scrub -- index.ts public surface, util.ts move, doc comments

Tightens compute/index.ts to export only the new-world surface. Moves the two
p-retry/p-wait-for helpers from compute/util.ts into compute/ec2/retry.ts where
they're actually used. Scrubs JSDoc comments that still referenced deleted
modules.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Push and open PR

**Files:** none.

- [ ] **Step 1: Push the branch**

```bash
git push -u origin refactor/compute-cleanup
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "refactor(compute): finish two-axis migration; delete arc.json; collapse compute/+workspace/ under core/" --body "$(cat <<'EOF'
## Summary

Implements `docs/superpowers/specs/2026-05-05-compute-cleanup-design.md`. One PR doing the full cleanup the spec lays out.

- Folds `packages/compute/` and `packages/workspace/` back under `packages/core/` (no real package boundary, cyclic imports gone)
- Deletes `arc.json` user-facing format and `arc-json.ts` parser; port discovery moves to the isolation layer that actually reads `devcontainer.json` / `docker-compose.yml`
- Adds post-launch ops (`kill`, `captureOutput`, `checkAlive`, `getMetrics`) to the new `AgentHandle` / `ComputeHandle` interfaces; `ComputeTarget` now covers the full lifecycle
- Deletes `packages/compute/providers/` entirely (10 provider classes + 4 placement-ctx files)
- Drops the legacy `provider` column from `compute`, `compute_templates`, and `hosted_*` tables (migration `010`)
- Coerces phantom `isolation_kind = "firecracker-in-container"` rows to `compute_kind = firecracker, isolation_kind = direct`
- Inlines the flag-spec registry into `cli/commands/compute/create.ts` (~80 lines, one file, no abstraction)
- Replaces CLI `--provider` with `--kind` + `--isolation`

## Test plan

- [ ] `make format && make lint && make test` green locally
- [ ] `make drift` green (drizzle dual-dialect schema check)
- [ ] Manual: `./ark compute create --kind local --isolation direct --name smoke && ./ark compute list && ./ark compute delete smoke`
- [ ] Manual: dispatch a session against a `local + direct` compute, confirm it launches, confirm `ark session show` displays metrics, confirm session can be killed
- [ ] Manual: dispatch against `local + docker`, same checks
- [ ] If you have AWS creds: `./ark compute create --kind ec2 --isolation direct --name smoke-ec2`, dispatch a session, kill, delete

## Out of scope

The follow-up backlog from the architectural audit is filed as issues #488-#515. None of those are addressed here.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review Notes

The plan covers every requirement from the spec:

- **Spec "Goals" section coverage:**
  - Single source of truth per provider → Tasks 3, 4
  - Single per-repo config (.ark.yaml only) → Task 2
  - ComputeTarget covers full lifecycle → Task 3
  - Schema reflects two-axis only → Task 5
  - packages/ shrinks → Tasks 1, 4
  - Every smell from review fixed → Tasks 2-7

- **Spec "Non-goals" coverage:**
  - No backwards compatibility anywhere → enforced by every "delete" step that has no fallback
  - Phantom kind erased → Task 7
  - Flag-spec registry deleted → Task 6
  - Legacy provider column dropped, no fallback → Task 5

- **Spec "Migration order" steps 1-8:** Tasks 1, 2, 3, 4, 5, 6, 7, 8 — one to one.

- **Risk Assessment items:** addressed by `make drift` gate (Task 5 step 4), by step-by-step build-green requirements after every commit, by the explicit verification greps in Tasks 5/7/8.

No placeholders remain. Type names used in later tasks (`AgentHandle.kill`, `ComputeHandle.getMetrics`, `discoverWorkspacePorts`, `findComposeFile`) all match their definition tasks.

The branch question (whether to base off `main` or `refactor/arkd-separation`) is resolved in Task 0 by basing off `main`.
