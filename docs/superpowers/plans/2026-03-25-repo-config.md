# Repo-Scoped Config (.ark.yaml) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support `.ark.yaml` in the target repo root as team-shareable project defaults for flow, compute, agents, group, and sync files.

**Architecture:** A new `loadRepoConfig(repoDir)` function reads `.ark.yaml` from a directory, returning typed defaults. `startSession` merges these with explicit options (explicit wins). The TUI `NewSessionForm` pre-fills from repo config when a repo is selected. Complements existing `arc.json` (which handles ports/sync/compose/devcontainer).

**Tech Stack:** YAML parsing (already using `yaml` package), existing session/form infrastructure

---

## .ark.yaml Format

```yaml
# Project defaults for Ark sessions
flow: default           # default flow for this repo
compute: local          # default compute target
group: my-project       # auto-group sessions from this repo
agent: implementer      # default agent (for bare flows)
env:                    # env vars passed to Claude launcher
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80"
```

All fields optional. Explicit CLI/TUI options override everything.

---

## File Structure

| File | Change |
|------|--------|
| `packages/core/repo-config.ts` | **Create:** `loadRepoConfig(dir)` — reads and parses `.ark.yaml` |
| `packages/core/index.ts` | **Modify:** Re-export |
| `packages/core/session.ts` | **Modify:** `startSession` merges repo config defaults |
| `packages/tui/forms/NewSessionForm.tsx` | **Modify:** Pre-fill from repo config when repo changes |
| `packages/core/__tests__/repo-config.test.ts` | **Create:** Tests |

---

### Task 1: Create loadRepoConfig

**Files:**
- Create: `packages/core/repo-config.ts`
- Create: `packages/core/__tests__/repo-config.test.ts`
- Modify: `packages/core/index.ts`

```ts
// packages/core/repo-config.ts
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import YAML from "yaml";

export interface RepoConfig {
  flow?: string;
  compute?: string;
  group?: string;
  agent?: string;
  env?: Record<string, string>;
}

/** Load .ark.yaml from a directory. Returns empty config if missing. */
export function loadRepoConfig(dir: string): RepoConfig {
  for (const name of [".ark.yaml", ".ark.yml", "ark.yaml"]) {
    const path = join(dir, name);
    if (existsSync(path)) {
      try {
        return (YAML.parse(readFileSync(path, "utf-8")) ?? {}) as RepoConfig;
      } catch { return {}; }
    }
  }
  return {};
}
```

Tests:
- Returns empty for directory with no config
- Loads .ark.yaml with all fields
- Loads .ark.yml variant
- Handles malformed YAML gracefully (returns empty)
- Handles missing fields (partial config)
- Ignores unknown fields

- [ ] **Step 1: Write tests**
- [ ] **Step 2: Implement**
- [ ] **Step 3: Add re-export to index.ts**
- [ ] **Step 4: Run tests**
- [ ] **Step 5: Commit**

```bash
git commit -m "feat: loadRepoConfig reads .ark.yaml from repo directory"
```

---

### Task 2: Merge into startSession

**Files:**
- Modify: `packages/core/session.ts`

In `startSession()`, if `opts.workdir` or `opts.repo` is provided, load the repo config and use its values as defaults (explicit opts win):

```ts
import { loadRepoConfig } from "./repo-config.js";

export function startSession(opts: { ... }): store.Session {
  // Load repo config defaults
  const repoDir = opts.workdir ?? opts.repo;
  const repoConfig = repoDir ? loadRepoConfig(repoDir) : {};

  // Merge: explicit options override repo config
  const mergedOpts = {
    ...opts,
    flow: opts.flow ?? repoConfig.flow ?? "default",
    compute_name: opts.compute_name ?? repoConfig.compute,
    group_name: opts.group_name ?? repoConfig.group,
  };

  const session = store.createSession(mergedOpts);
  // ... rest unchanged
}
```

Also pass `repoConfig.env` into the session config so `buildLauncher` picks it up:

```ts
config: {
  ...opts.config,
  ...(repoConfig.env ? { env: repoConfig.env } : {}),
},
```

Tests: add to existing `session-compute.test.ts` or create new:
- Session created in repo with .ark.yaml gets default flow
- Session created with explicit flow overrides .ark.yaml
- Session without workdir ignores repo config

- [ ] **Step 1: Add repo config merge to startSession**
- [ ] **Step 2: Write tests**
- [ ] **Step 3: Run tests**
- [ ] **Step 4: Commit**

```bash
git commit -m "feat: startSession merges .ark.yaml defaults — flow, compute, group"
```

---

### Task 3: Pre-fill NewSessionForm from repo config

**Files:**
- Modify: `packages/tui/forms/NewSessionForm.tsx`

When the user changes the repo path, load the repo config and pre-fill the form fields:

```ts
import { loadRepoConfig } from "../../core/repo-config.js";

// After repoPath changes, load config
const repoConfig = useMemo(() => {
  try { return loadRepoConfig(resolvePath(repoPath)); } catch { return {}; }
}, [repoPath]);

// Use repo config as initial values (only if not already set by user)
useEffect(() => {
  if (repoConfig.flow) setFlowName(repoConfig.flow);
  if (repoConfig.compute) setComputeName(repoConfig.compute);
  if (repoConfig.group) setGroupName(repoConfig.group);
}, [repoConfig]);
```

This is a UX enhancement — when you pick a repo that has `.ark.yaml`, the form auto-fills with project defaults.

- [ ] **Step 1: Add repo config loading to form**
- [ ] **Step 2: Test manually in TUI**
- [ ] **Step 3: Commit**

```bash
git commit -m "feat: NewSessionForm pre-fills from .ark.yaml when repo changes"
```

---

### Task 4: E2E test + push

**Files:**
- Create: `packages/core/__tests__/e2e-repo-config.test.ts`

Full flow: write `.ark.yaml` to a temp dir, call `startSession({ workdir: tempDir })`, verify session gets the flow/group from the config.

- [ ] **Step 1: Write E2E test**
- [ ] **Step 2: Run all tests**
- [ ] **Step 3: Commit and push**

```bash
git commit -m "test: E2E tests for repo-scoped config"
git push
```
