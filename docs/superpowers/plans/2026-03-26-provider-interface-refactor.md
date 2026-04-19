# Provider Interface Refactor -- Eliminate Local vs Remote Branching

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove all `provider === "local"` / `provider !== "local"` conditional logic from callers. Every compute operation goes through `ComputeProvider` methods -- zero branching on provider type.

**Architecture:** Extend the `ComputeProvider` interface with capability flags (`canReboot`, `canDelete`, `supportsWorktree`) and new methods (`checkSession`, `getAttachCommand`, `buildChannelConfig`, `buildLaunchEnv`). Implement in both `LocalProvider` and `EC2Provider`. Then replace all 30+ branching sites with provider method calls.

**Tech Stack:** TypeScript, bun:test, Ink/React TUI

---

## File Structure

| File | Role | Change Type |
|------|------|-------------|
| `packages/compute/types.ts` | Provider interface | Modify: add flags + methods |
| `packages/compute/providers/local/index.ts` | Local provider | Modify: implement new methods |
| `packages/compute/providers/ec2/index.ts` | EC2 provider | Modify: implement new methods |
| `packages/core/session.ts` | Session lifecycle | Modify: remove isLocal/isRemote branching |
| `packages/core/claude.ts` | Channel config | Modify: remove remote flag |
| `packages/core/store.ts` | DB CRUD | Modify: remove provider status check |
| `packages/tui/hooks/useStore.ts` | Polling/reconcile | Modify: use provider.checkSession |
| `packages/tui/tabs/SessionsTab.tsx` | Session UI | Modify: use provider.getAttachCommand |
| `packages/tui/hooks/useComputeActions.ts` | Compute actions | Modify: use provider flags |
| `packages/tui/tabs/ComputeTab.tsx` | Compute UI | Modify: use provider flags |
| `packages/compute/__tests__/provider-interface.test.ts` | New tests | Create |

---

### Task 1: Extend ComputeProvider Interface

**Files:**
- Modify: `packages/compute/types.ts`
- Create: `packages/compute/__tests__/provider-interface.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/compute/__tests__/provider-interface.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { LocalProvider } from "../providers/local/index.js";
import { EC2Provider } from "../providers/ec2/index.js";

describe("ComputeProvider interface", () => {
  const local = new LocalProvider();
  const ec2 = new EC2Provider();

  it("local has capability flags", () => {
    expect(local.canReboot).toBe(false);
    expect(local.canDelete).toBe(false);
    expect(local.supportsWorktree).toBe(true);
    expect(local.initialStatus).toBe("running");
    expect(local.needsAuth).toBe(false);
  });

  it("ec2 has capability flags", () => {
    expect(ec2.canReboot).toBe(true);
    expect(ec2.canDelete).toBe(true);
    expect(ec2.supportsWorktree).toBe(false);
    expect(ec2.initialStatus).toBe("stopped");
    expect(ec2.needsAuth).toBe(true);
  });

  it("local has new methods", () => {
    expect(typeof local.checkSession).toBe("function");
    expect(typeof local.getAttachCommand).toBe("function");
    expect(typeof local.buildChannelConfig).toBe("function");
    expect(typeof local.buildLaunchEnv).toBe("function");
  });

  it("ec2 has new methods", () => {
    expect(typeof ec2.checkSession).toBe("function");
    expect(typeof ec2.getAttachCommand).toBe("function");
    expect(typeof ec2.buildChannelConfig).toBe("function");
    expect(typeof ec2.buildLaunchEnv).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/compute/__tests__/provider-interface.test.ts --timeout 15000`
Expected: FAIL -- properties/methods don't exist yet

- [ ] **Step 3: Add new members to ComputeProvider interface**

In `packages/compute/types.ts`, add to the `ComputeProvider` interface:

```typescript
  // ── Capability flags ────────────────────────────────────────────────────
  readonly canReboot: boolean;
  readonly canDelete: boolean;
  readonly supportsWorktree: boolean;
  readonly initialStatus: string;
  readonly needsAuth: boolean;

  // ── Session lifecycle (extended) ──────────────────────────────────────
  checkSession(compute: Compute, tmuxSessionId: string): Promise<boolean>;
  getAttachCommand(compute: Compute, session: Session): string[];
  buildChannelConfig(sessionId: string, stage: string, channelPort: number, opts?: { conductorUrl?: string }): Record<string, unknown>;
  buildLaunchEnv(session: Session): Record<string, string>;
```

- [ ] **Step 4: Commit**

```bash
git add packages/compute/types.ts packages/compute/__tests__/provider-interface.test.ts
git commit -m "feat: extend ComputeProvider interface with capability flags and methods"
```

---

### Task 2: Implement New Methods in LocalProvider

**Files:**
- Modify: `packages/compute/providers/local/index.ts`

- [ ] **Step 1: Add capability flags and new methods**

Add to the `LocalProvider` class:

```typescript
readonly canReboot = false;
readonly canDelete = false;
readonly supportsWorktree = true;
readonly initialStatus = "running";
readonly needsAuth = false;

async checkSession(_compute: Compute, tmuxSessionId: string): Promise<boolean> {
  const tmux = await import("../../../core/tmux.js");
  return tmux.sessionExistsAsync(tmuxSessionId);
}

getAttachCommand(_compute: Compute, session: Session): string[] {
  if (!session.session_id) return [];
  return ["tmux", "attach", "-t", session.session_id];
}

buildChannelConfig(sessionId: string, stage: string, channelPort: number, opts?: { conductorUrl?: string }): Record<string, unknown> {
  const { join } = require("path");
  const { homedir } = require("os");
  return {
    command: join(homedir(), ".bun", "bin", "bun"),
    args: [join(__dirname, "../../../core/channel.ts")],
    env: {
      ARK_SESSION_ID: sessionId,
      ARK_STAGE: stage,
      ARK_CHANNEL_PORT: String(channelPort),
      ARK_CONDUCTOR_URL: opts?.conductorUrl ?? "http://localhost:19100",
    },
  };
}

buildLaunchEnv(_session: Session): Record<string, string> {
  return {};
}
```

- [ ] **Step 2: Run tests**

Run: `bun test packages/compute/__tests__/provider-interface.test.ts --timeout 15000`
Expected: Local tests PASS, EC2 tests FAIL

- [ ] **Step 3: Commit**

```bash
git add packages/compute/providers/local/index.ts
git commit -m "feat: implement extended provider interface in LocalProvider"
```

---

### Task 3: Implement New Methods in EC2Provider

**Files:**
- Modify: `packages/compute/providers/ec2/index.ts`

- [ ] **Step 1: Add capability flags and new methods**

```typescript
readonly canReboot = true;
readonly canDelete = true;
readonly supportsWorktree = false;
readonly initialStatus = "stopped";
readonly needsAuth = true;

async checkSession(compute: Compute, tmuxSessionId: string): Promise<boolean> {
  try {
    const { queue } = this.getQueue(compute);
    return await queue.command(async (p) => {
      const { exitCode } = await p.exec(
        `tmux has-session -t '${tmuxSessionId}'`, { timeout: 10_000 });
      return exitCode === 0;
    });
  } catch { return false; }
}

getAttachCommand(compute: Compute, session: Session): string[] {
  const cfg = compute.config as any;
  if (!cfg?.ip || !session.session_id) return [];
  return [
    "ssh", "-i", sshKeyPath(compute.name),
    "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10", "-t",
    `ubuntu@${cfg.ip}`, `tmux attach -t ${session.session_id}`,
  ];
}

buildChannelConfig(sessionId: string, stage: string, channelPort: number, opts?: { conductorUrl?: string }): Record<string, unknown> {
  return {
    command: "/home/ubuntu/.ark/bin/ark",
    args: ["channel"],
    env: {
      ARK_SESSION_ID: sessionId,
      ARK_STAGE: stage,
      ARK_CHANNEL_PORT: String(channelPort),
      ARK_CONDUCTOR_URL: opts?.conductorUrl ?? "http://localhost:19100",
    },
  };
}

buildLaunchEnv(_session: Session): Record<string, string> {
  const env: Record<string, string> = {};
  const token = process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN;
  if (token) env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = token;
  let oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!oauthToken) {
    try {
      const { existsSync, readFileSync } = require("fs");
      const { join } = require("path");
      const { ARK_DIR } = require("../../../core/store.js");
      const p = join(ARK_DIR(), "claude-oauth-token");
      if (existsSync(p)) oauthToken = readFileSync(p, "utf-8").trim();
    } catch {}
  }
  if (oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  return env;
}
```

- [ ] **Step 2: Run all provider tests**

Run: `bun test packages/compute/__tests__/provider-interface.test.ts packages/compute/__tests__/ec2-provider.test.ts --timeout 15000`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add packages/compute/providers/ec2/index.ts
git commit -m "feat: implement extended provider interface in EC2Provider"
```

---

### Task 4: Refactor session.ts -- Remove isLocal/isRemote

**Files:**
- Modify: `packages/core/session.ts`
- Modify: `packages/core/claude.ts`

- [ ] **Step 1: Update writeChannelConfig to accept provider-built config**

In `packages/core/claude.ts`, modify `writeChannelConfig` to accept an optional `channelConfig` parameter:

```typescript
export function writeChannelConfig(
  sessionId: string, stage: string, channelPort: number,
  workdir: string,
  opts?: { conductorUrl?: string; channelConfig?: Record<string, unknown> },
): string {
  const config = opts?.channelConfig
    ?? channelMcpConfig(sessionId, stage, channelPort, { conductorUrl: opts?.conductorUrl });
  // ... use config instead of channelMcpConfig(...)
```

Remove the `remote?: boolean` from `channelMcpConfig` and the branching inside it. Keep only the local version as a default fallback.

- [ ] **Step 2: Refactor launchAgentTmux in session.ts**

Replace all `isLocal` / `isRemote` / `compute.provider !== "local"` with provider method calls:

1. Get provider: `const provider = getProviderForSession(session);`
2. Worktree: `if (provider.supportsWorktree && ...)`
3. Channel: `const channelConfig = provider.buildChannelConfig(sessionId, stage, channelPort, { conductorUrl })`
4. Launch env: `const launchEnv = { ...(agent.env ?? {}), ...provider.buildLaunchEnv(session) }`
5. Remove the dedicated `if (isRemote) { token... }` block

- [ ] **Step 3: Run tests**

Run: `bun test packages/core/__tests__/session-stop-resume.test.ts packages/core/__tests__/claude.test.ts --timeout 30000`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/core/session.ts packages/core/claude.ts
git commit -m "refactor: session dispatch uses provider methods, no isLocal/isRemote"
```

---

### Task 5: Refactor store.ts -- Provider Sets Initial Status

**Files:**
- Modify: `packages/core/store.ts`

- [ ] **Step 1: Replace hardcoded status**

```typescript
// Before (line 444):
const status = provider === "local" ? "running" : "stopped";

// After:
const { getProvider } = require("../../compute/index.js");
const providerInstance = getProvider(opts.provider ?? "local");
const status = providerInstance?.initialStatus ?? "stopped";
```

- [ ] **Step 2: Run tests**

Run: `bun test packages/core/__tests__/store-compute.test.ts --timeout 15000`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/core/store.ts
git commit -m "refactor: createCompute uses provider.initialStatus"
```

---

### Task 6: Refactor useStore.ts -- reconcileSessions via Provider

**Files:**
- Modify: `packages/tui/hooks/useStore.ts`

- [ ] **Step 1: Replace local tmux check**

```typescript
// Before:
if (s.compute_name) {
  const compute = core.getCompute(s.compute_name);
  if (compute && compute.provider !== "local") continue;
}
const exists = await core.sessionExistsAsync(s.session_id);

// After:
const computeName = s.compute_name ?? "local";
const compute = core.getCompute(computeName);
if (!compute) continue;
const provider = getProvider(compute.provider);
if (!provider) continue;
const exists = await provider.checkSession(compute, s.session_id);
```

Add import: `import { getProvider } from "../../compute/index.js";`

- [ ] **Step 2: Run tests and commit**

```bash
bun test packages/tui/__tests__/tui-render.test.tsx --timeout 15000
git add packages/tui/hooks/useStore.ts
git commit -m "refactor: reconcileSessions uses provider.checkSession"
```

---

### Task 7: Refactor SessionsTab.tsx -- Attach and Auth via Provider

**Files:**
- Modify: `packages/tui/tabs/SessionsTab.tsx`

- [ ] **Step 1: Replace auth check**

```typescript
// Use provider.needsAuth instead of provider !== "local"
const provider = compute ? getProvider(compute.provider) : null;
if (provider?.needsAuth) {
  // auth check logic stays the same
}
```

- [ ] **Step 2: Replace attach handler**

```typescript
// Use provider.checkSession + provider.getAttachCommand
const attachCompute = compute ?? core.getCompute("local")!;
const provider = getProvider(attachCompute.provider)!;
const exists = await provider.checkSession(attachCompute, sid);
if (!exists) { status.show("Session not found"); return; }
attachCmd = provider.getAttachCommand(attachCompute, selected);
if (attachCmd.length === 0) { status.show("Cannot attach"); return; }
```

- [ ] **Step 3: Clean up imports**

Remove `existsSync`, `join`, `execFile` imports if no longer used elsewhere in the file.

- [ ] **Step 4: Run tests and commit**

```bash
bun test packages/tui/__tests__/tui-render.test.tsx --timeout 15000
git add packages/tui/tabs/SessionsTab.tsx
git commit -m "refactor: attach and auth use provider methods"
```

---

### Task 8: Refactor useComputeActions.ts -- Use Provider Flags

**Files:**
- Modify: `packages/tui/hooks/useComputeActions.ts`

- [ ] **Step 1: Replace guards**

```typescript
// reboot: use canReboot
const provider = getProvider(compute.provider);
if (!provider?.canReboot) return;

// delete: always try stop (provider.stop is a no-op for local)
const provider = getProvider(compute.provider);
if (provider) { try { await provider.stop(compute); } catch {} }

// ping: remove local early return, let provider handle it
```

- [ ] **Step 2: Run tests and commit**

```bash
bun test packages/tui/__tests__/useComputeActions.test.ts --timeout 15000
git add packages/tui/hooks/useComputeActions.ts
git commit -m "refactor: compute actions use provider capability flags"
```

---

### Task 9: Refactor ComputeTab.tsx -- Use Provider Flags

**Files:**
- Modify: `packages/tui/tabs/ComputeTab.tsx`

- [ ] **Step 1: Replace delete and reboot guards**

```typescript
// delete: use canDelete
const provider = selected ? getProvider(selected.provider) : null;
if (!provider?.canDelete) { status.show("Cannot delete this compute"); return; }

// reboot: use canReboot
if (selected && getProvider(selected.provider)?.canReboot) { actions.reboot(selected); }
```

- [ ] **Step 2: Run tests and commit**

```bash
bun test packages/tui/__tests__/tui-render.test.tsx --timeout 15000
git add packages/tui/tabs/ComputeTab.tsx
git commit -m "refactor: compute tab uses provider capability flags"
```

---

### Task 10: Final Verification

- [ ] **Step 1: Fix any remaining tests**

Run: `bun test --timeout 30000 $(find packages -name '*.test.ts' -o -name '*.test.tsx' | grep -v e2e | sort)`
Fix any failures.

- [ ] **Step 2: Verify zero remaining provider branching**

Run: `grep -rn "provider !== .local.\|provider === .local.\|isLocal\|isRemote" packages/ --include="*.ts" --include="*.tsx" | grep -v __tests__ | grep -v node_modules`
Expected: Zero matches

- [ ] **Step 3: Push and verify CI**

```bash
git push origin main
```
Expected: CI ALL GREEN
