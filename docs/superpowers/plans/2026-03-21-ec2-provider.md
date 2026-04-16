# EC2 Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the EC2 compute provider using Pulumi Automation API -- SSH primitives, cloud-init, provisioning, environment sync, metrics, port tunneling, cost tracking, and idle shutdown.

**Architecture:** The EC2 provider implements the `ComputeProvider` interface from Plan 1. It uses `@pulumi/pulumi` + `@pulumi/aws` for infrastructure lifecycle (provision/destroy), SSH for remote operations (metrics, sync, launch, port tunneling), and cloud-init for instance bootstrapping. Each host gets its own Pulumi stack (`ark-compute-{name}`) with local backend state at `~/.ark/pulumi/`.

**Tech Stack:** TypeScript, Bun, `@pulumi/pulumi`, `@pulumi/aws`, `@aws-sdk/client-ec2` (for start/stop), `@aws-sdk/client-cost-explorer`

**Spec:** `docs/superpowers/specs/2026-03-21-compute-layer-design.md`

**Depends on:** Plan 1 (Compute Foundation) -- completed.

**Note on test runner:** Tests use `bun:test` and are run via `bun test`.

**Reference code:**
- Original Arc: `~/Projects/arc-original/provisioners/ec2.py` (Pulumi provisioning)
- Original Arc: `~/Projects/arc-original/remote/cloud-init.yaml` (instance bootstrap)
- BigBox: `~/Projects/bigbox/bigbox/ssh.py` (SSH primitives)
- BigBox: `~/Projects/bigbox/bigbox/dashboard/fetch.py` + `parse.py` (SSH metrics)
- BigBox: `~/Projects/bigbox/bigbox/cloud_init.py` (cloud-init script)
- BigBox: `~/Projects/bigbox/bigbox/sync/settings.py` (credential sync)

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `packages/compute/providers/ec2/ssh.ts` | SSH exec, rsync push/pull, wait-for-SSH |
| `packages/compute/providers/ec2/cloud-init.ts` | User-data script builder with idle shutdown |
| `packages/compute/providers/ec2/provision.ts` | Pulumi Automation API: stack management, inline program |
| `packages/compute/providers/ec2/sync.ts` | Credential sync (push/pull), Claude session bidirectional sync, path rewriting |
| `packages/compute/providers/ec2/metrics.ts` | SSH-based metrics collection + section parser |
| `packages/compute/providers/ec2/ports.ts` | SSH tunnel management (setup/teardown/probe) |
| `packages/compute/providers/ec2/cost.ts` | Pricing tables + Cost Explorer queries with cache |
| `packages/compute/providers/ec2/clipboard.ts` | macOS clipboard → remote session file push |
| `packages/compute/providers/ec2/index.ts` | EC2Provider class implementing ComputeProvider |

### Modified files

| File | Changes |
|------|---------|
| `packages/compute/index.ts` | Import and register EC2Provider |
| `package.json` | Add Pulumi and AWS SDK dependencies |

---

## Task 1: Install dependencies and SSH primitives

**Files:**
- Modify: `package.json` (add deps)
- Create: `packages/compute/providers/ec2/ssh.ts`
- Create: `packages/compute/__tests__/ec2-ssh.test.ts`

- [ ] **Step 1: Install Pulumi and AWS SDK deps**

```bash
cd /Users/yana/Projects/ark && bun add @pulumi/pulumi @pulumi/aws @aws-sdk/client-ec2 @aws-sdk/client-cost-explorer
```

- [ ] **Step 2: Write failing test for SSH arg builders**

Create `packages/compute/__tests__/ec2-ssh.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import {
  sshKeyPath, sshBaseArgs, sshExec,
  rsyncPushArgs, rsyncPullArgs,
} from "../providers/ec2/ssh.js";

describe("ec2 ssh", () => {
  it("sshKeyPath returns path under ~/.ssh/", () => {
    const p = sshKeyPath("dev");
    expect(p).toContain(".ssh/ark-dev");
  });

  it("sshBaseArgs builds correct SSH command", () => {
    const args = sshBaseArgs("/path/key", "1.2.3.4");
    expect(args[0]).toBe("ssh");
    expect(args).toContain("-i");
    expect(args).toContain("/path/key");
    expect(args[args.length - 1]).toBe("ubuntu@1.2.3.4");
  });

  it("sshBaseArgs adds port forwards", () => {
    const args = sshBaseArgs("/path/key", "1.2.3.4", [3000, 8080]);
    expect(args).toContain("-L");
    expect(args).toContain("3000:localhost:3000");
  });

  it("rsyncPushArgs builds rsync command", () => {
    const args = rsyncPushArgs("/path/key", "1.2.3.4", "/local/", "/remote/");
    expect(args[0]).toBe("rsync");
    expect(args[args.length - 1]).toBe("ubuntu@1.2.3.4:/remote/");
  });

  it("rsyncPullArgs builds reverse rsync", () => {
    const args = rsyncPullArgs("/path/key", "1.2.3.4", "/remote/", "/local/");
    expect(args[0]).toBe("rsync");
    expect(args[args.length - 1]).toBe("/local/");
  });

  it("sshExec handles command failure gracefully", () => {
    // Connecting to a non-existent host should fail without throwing
    const result = sshExec("/nonexistent/key", "192.0.2.1", "echo test", { timeout: 2 });
    expect(result.exitCode).not.toBe(0);
  });
});
```

- [ ] **Step 3: Implement ssh.ts**

Create `packages/compute/providers/ec2/ssh.ts` -- port from BigBox's `ssh.py`:
- `sshKeyPath(hostName)` → `~/.ssh/ark-{hostName}`
- `SSH_OPTS` array (StrictHostKeyChecking=no, ConnectTimeout=10, ServerAliveInterval=10, LogLevel=ERROR)
- `sshBaseArgs(key, ip, ports?)` → build SSH command args with optional -L forwards
- `sshExec(key, ip, cmd, opts?)` → execFileSync wrapper, returns `{ stdout, stderr, exitCode }`, catches errors
- `rsyncPushArgs(key, ip, local, remote)` → rsync command args
- `rsyncPullArgs(key, ip, remote, local)` → reverse
- `rsyncPush(key, ip, local, remote)` → execute rsync push
- `rsyncPull(key, ip, remote, local)` → execute rsync pull
- `waitForSsh(key, ip, maxAttempts?)` → poll SSH readiness with 5s sleep between attempts

All shell commands use `execFileSync` (not `exec`) for safety.

- [ ] **Step 4: Run tests, verify pass**

```bash
bun test packages/compute/__tests__/ec2-ssh.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock packages/compute/providers/ec2/ssh.ts packages/compute/__tests__/ec2-ssh.test.ts
git commit -m "feat: add EC2 SSH primitives and install Pulumi/AWS deps"
```

---

## Task 2: Cloud-init and idle shutdown

**Files:**
- Create: `packages/compute/providers/ec2/cloud-init.ts`
- Create: `packages/compute/__tests__/ec2-cloud-init.test.ts`

- [ ] **Step 1: Write failing test**

Test that `buildUserData()` returns a bash script containing required packages (nodejs, docker, gh, tmux, bun, claude) and the idle shutdown cron. Test that custom idle timeout produces correct tick count.

- [ ] **Step 2: Implement cloud-init.ts**

Port from BigBox's `cloud_init.py` and original Arc's `remote/cloud-init.yaml`. Single exported function `buildUserData(opts?)` that returns a bash string.

Key packages: git, curl, build-essential, Node.js 22, Python 3, Docker + devcontainer CLI, AWS CLI v2, GitHub CLI, Claude Code, bun, nvm, tmux.

Idle shutdown script: `ark-idle-shutdown` checks `who` for logged-in users, checks Claude processes for ESTAB sockets. Configurable tick threshold (default 6 = 60 min).

Tmux config: mouse support, Ctrl+Q detach, 50k history.

- [ ] **Step 3: Run tests, commit**

```bash
bun test packages/compute/__tests__/ec2-cloud-init.test.ts
git add packages/compute/providers/ec2/cloud-init.ts packages/compute/__tests__/ec2-cloud-init.test.ts
git commit -m "feat: add cloud-init builder with idle shutdown"
```

---

## Task 3: Pulumi EC2 provisioning

**Files:**
- Create: `packages/compute/providers/ec2/provision.ts`
- Create: `packages/compute/__tests__/ec2-provision.test.ts`

- [ ] **Step 1: Write failing test**

Test exports exist (`provisionStack`, `destroyStack`, `resolveInstanceType`, `INSTANCE_SIZES`). Test `resolveInstanceType("m", "x64")` → `"m6i.2xlarge"`, test `resolveInstanceType("m", "arm")` → `"m6g.2xlarge"`, test unknown size passes through as literal.

- [ ] **Step 2: Implement provision.ts**

Port from original Arc's `provisioners/ec2.py`:
- `INSTANCE_SIZES` constant (xs→xxxl, x64/arm)
- `resolveInstanceType(size, arch, fallback)` → instance type string
- `generateSshKey(hostName)` → create ed25519 key at `~/.ssh/ark-{hostName}`
- `buildPulumiProgram(opts)` → inline Pulumi program function that creates SG + EC2 instance
- `provisionStack(hostName, opts)` → create/select Pulumi stack, run `stack.up()`, return outputs (ip, instance_id)
- `destroyStack(hostName, opts)` → `stack.destroy()` + `stack.workspace.removeStack()`

Use `@pulumi/pulumi` Automation API with local backend at `~/.ark/pulumi/`. Stack name: `ark-compute-{hostName}`.

- [ ] **Step 3: Run tests, commit**

```bash
bun test packages/compute/__tests__/ec2-provision.test.ts
git add packages/compute/providers/ec2/provision.ts packages/compute/__tests__/ec2-provision.test.ts
git commit -m "feat: add Pulumi EC2 provisioning"
```

---

## Task 4: Environment sync

**Files:**
- Create: `packages/compute/providers/ec2/sync.ts`
- Create: `packages/compute/__tests__/ec2-sync.test.ts`

- [ ] **Step 1: Write failing test**

Test `rewritePaths(content, "push")` converts `/Users/{user}` → `/home/ubuntu`. Test `rewritePaths(content, "pull")` reverses. Test `SYNC_CATEGORIES` contains expected entries (ssh, aws, git, gh, claude). Test `buildSyncPlan("push")` returns an array of steps.

- [ ] **Step 2: Implement sync.ts**

Port from BigBox's `sync/settings.py`:
- `rewritePaths(content, direction)` → string replacement for Claude config path rewriting
- `SYNC_CATEGORIES` -- array of `{ name, push(key, ip), pull(key, ip) }`:
  - `ssh`: rsync `~/.ssh/` (push only, filter out `ark-*` keys)
  - `aws`: rsync `~/.aws/config` + `~/.aws/credentials` (push only)
  - `git`: rsync `~/.gitconfig` (push only)
  - `gh`: authenticate via `gh auth token` piped to remote `gh auth login` (push only)
  - `claude`: rsync `~/.claude/` with path rewriting (bidirectional)
- `syncToHost(key, ip, opts)` → execute sync categories
- `syncProjectFiles(key, ip, files, localDir, remoteDir)` → push arc.json sync files

- [ ] **Step 3: Run tests, commit**

```bash
bun test packages/compute/__tests__/ec2-sync.test.ts
git add packages/compute/providers/ec2/sync.ts packages/compute/__tests__/ec2-sync.test.ts
git commit -m "feat: add environment sync for EC2 hosts"
```

---

## Task 5: EC2 metrics collection

**Files:**
- Create: `packages/compute/providers/ec2/metrics.ts`
- Create: `packages/compute/__tests__/ec2-metrics.test.ts`

- [ ] **Step 1: Write failing test**

Test `parseSnapshot(sampleOutput)` with a multi-section sample SSH output (same format as BigBox). Verify it correctly extracts CPU, memory, disk, network, sessions, processes.

- [ ] **Step 2: Implement metrics.ts**

Port from BigBox's `dashboard/fetch.py` + `parse.py`:
- `SSH_FAST_CMD` -- single SSH command with section-delimited output (`=== CPU ===`, etc.)
- `SSH_DOCKER_CMD` -- docker stats + docker ps
- `parseSections(stdout)` → parse `=== SECTION ===` delimited output into `Record<string, string[]>`
- `parseSnapshot(stdout)` → parse sections into `HostSnapshot`
- `fetchMetrics(key, ip)` → `sshExec` + `parseSnapshot`
- `fetchDocker(key, ip)` → separate slow fetch for Docker stats

- [ ] **Step 3: Run tests, commit**

```bash
bun test packages/compute/__tests__/ec2-metrics.test.ts
git add packages/compute/providers/ec2/metrics.ts packages/compute/__tests__/ec2-metrics.test.ts
git commit -m "feat: add SSH-based EC2 metrics collection"
```

---

## Task 6: Port tunnel management

**Files:**
- Create: `packages/compute/providers/ec2/ports.ts`
- Create: `packages/compute/__tests__/ec2-ports.test.ts`

- [ ] **Step 1: Write failing test**

Test `buildTunnelArgs(key, ip, ports)` creates correct SSH -L flags. Test `probePorts(key, ip, ports)` builds the right remote `ss -tln` command.

- [ ] **Step 2: Implement ports.ts**

- `buildTunnelArgs(key, ip, ports)` → SSH args with `-L` for each port, `-N -f` for background
- `setupTunnels(key, ip, ports)` → spawn background SSH process with port forwards
- `teardownTunnels(ports)` → kill SSH processes for those ports
- `probeRemotePorts(key, ip, ports)` → SSH `ss -tln` and check which ports are listening, return `PortStatus[]`

- [ ] **Step 3: Run tests, commit**

```bash
bun test packages/compute/__tests__/ec2-ports.test.ts
git add packages/compute/providers/ec2/ports.ts packages/compute/__tests__/ec2-ports.test.ts
git commit -m "feat: add SSH tunnel management for EC2"
```

---

## Task 7: Cost tracking

**Files:**
- Create: `packages/compute/providers/ec2/cost.ts`
- Create: `packages/compute/__tests__/ec2-cost.test.ts`

- [ ] **Step 1: Write failing test**

Test `hourlyRate("m6i.2xlarge")` returns a positive number. Test `estimateDailyCost("m6i.2xlarge", 256)` returns reasonable value. Test unknown instance returns 0.

- [ ] **Step 2: Implement cost.ts**

Port from BigBox's `config.py` pricing + `aws.py` cost explorer:
- `PRICING` -- hourly rates for all m6i/m6g instance types
- `hourlyRate(instanceType)` → lookup
- `estimateDailyCost(instanceType, diskGb)` → compute + storage
- `fetchAwsCost(hostName, opts?)` → Cost Explorer query with 4-hour cache

- [ ] **Step 3: Run tests, commit**

```bash
bun test packages/compute/__tests__/ec2-cost.test.ts
git add packages/compute/providers/ec2/cost.ts packages/compute/__tests__/ec2-cost.test.ts
git commit -m "feat: add EC2 cost tracking"
```

---

## Task 8: Clipboard sync

**Files:**
- Create: `packages/compute/providers/ec2/clipboard.ts`
- Create: `packages/compute/__tests__/ec2-clipboard.test.ts`

- [ ] **Step 1: Write failing test**

Test `getClipboardImage()` returns null when no image is in clipboard. Test `buildUploadCmd(localPath, remotePath)` returns correct rsync args.

- [ ] **Step 2: Implement clipboard.ts**

- `getClipboardImage()` → use `osascript` to check if clipboard has image, save to temp file, return path or null
- `uploadToSession(key, ip, localPath, remoteWorkdir)` → rsync the image to remote
- `watchClipboard(key, ip, remoteWorkdir, opts?)` → poll clipboard on interval, upload new images

- [ ] **Step 3: Run tests, commit**

```bash
bun test packages/compute/__tests__/ec2-clipboard.test.ts
git add packages/compute/providers/ec2/clipboard.ts packages/compute/__tests__/ec2-clipboard.test.ts
git commit -m "feat: add clipboard sync for EC2"
```

---

## Task 9: EC2Provider class

Tie everything together into the provider implementation.

**Files:**
- Create: `packages/compute/providers/ec2/index.ts`
- Create: `packages/compute/__tests__/ec2-provider.test.ts`
- Modify: `packages/compute/index.ts` (register EC2 provider)

- [ ] **Step 1: Write failing test**

Test that EC2Provider implements ComputeProvider (has all required methods). Test `provider.name === "ec2"`. Test that it's auto-registered after importing compute index.

- [ ] **Step 2: Implement EC2Provider**

Create `packages/compute/providers/ec2/index.ts`:

```typescript
export class EC2Provider implements ComputeProvider {
  readonly name = "ec2";

  async provision(host, opts?) {
    // 1. Generate SSH key
    // 2. Build cloud-init
    // 3. Call provisionStack()
    // 4. Update host in DB with instance_id, ip, sg_id, key_name, stack_name
    // 5. Wait for SSH
    // 6. Sync environment
  }

  async destroy(host) {
    // Call destroyStack()
  }

  async start(host) {
    // AWS SDK StartInstances + wait + get new IP
  }

  async stop(host) {
    // AWS SDK StopInstances + wait
  }

  async launch(host, session, opts) {
    // 1. SSH: write launcher to remote
    // 2. SSH: create tmux session
    // 3. Setup port tunnels
  }

  async attach(host, session) {
    // Re-establish port tunnels from session record
  }

  async getMetrics(host) {
    // fetchMetrics(key, ip)
  }

  async probePorts(host, ports) {
    // probeRemotePorts(key, ip, ports)
  }

  async syncEnvironment(host, opts) {
    // syncToHost() + syncProjectFiles()
  }
}
```

- [ ] **Step 3: Register in compute index**

Add to `packages/compute/index.ts`:
```typescript
import { EC2Provider } from "./providers/ec2/index.js";
export { EC2Provider };
registerProvider(new EC2Provider());
```

- [ ] **Step 4: Run all tests**

```bash
bun test
```

- [ ] **Step 5: Commit**

```bash
git add packages/compute/providers/ec2/index.ts packages/compute/__tests__/ec2-provider.test.ts packages/compute/index.ts
git commit -m "feat: add EC2Provider implementing ComputeProvider"
```

---

## Task 10: Integration verification

- [ ] **Step 1: Run full test suite**

```bash
bun test
```

- [ ] **Step 2: TypeScript compilation check**

```bash
bunx tsc --noEmit
```

- [ ] **Step 3: Fix any issues and commit**

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | SSH primitives + deps | `ec2/ssh.ts` |
| 2 | Cloud-init + idle shutdown | `ec2/cloud-init.ts` |
| 3 | Pulumi provisioning | `ec2/provision.ts` |
| 4 | Environment sync | `ec2/sync.ts` |
| 5 | SSH metrics collection | `ec2/metrics.ts` |
| 6 | Port tunnel management | `ec2/ports.ts` |
| 7 | Cost tracking | `ec2/cost.ts` |
| 8 | Clipboard sync | `ec2/clipboard.ts` |
| 9 | EC2Provider class | `ec2/index.ts` |
| 10 | Integration verification | -- |
