# EC2 Remote Dispatch Fix

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the EC2 provider's `launch()` so it properly sets up the remote environment before running Claude — clone repo, sync credentials, sync project files, pre-trust the directory, and launch Claude in the correct remote path.

**Architecture:** The provider is responsible for the full remote setup. `session.dispatch()` passes the session info to `provider.launch()`, and the provider handles everything: repo checkout, credential sync, project file sync, trust pre-acceptance, and Claude execution. The core dispatch layer should NOT know about remote paths — it passes the local context and the provider translates it to the remote environment.

**Tech Stack:** TypeScript, SSH (via `sshExecAsync`), rsync, git

---

## Current Problem

When dispatching a session to an EC2 host:
- `Workdir` shows `/Users/yana/Projects/ark` — a local macOS path that doesn't exist on the remote
- No repo clone happens on the remote
- No credential sync happens
- No arc.json project files are synced
- The Claude launch script references the local path, so Claude either fails or runs in the wrong directory
- The trust dialog fires because the remote directory isn't pre-trusted

## What EC2Provider.launch() Should Do

```
1. Determine remote repo path:
   - If session.repo looks like a GitHub URL → use it directly
   - If session.repo is a local path → extract the git remote URL
   - If neither → error

2. Clone/update repo on remote:
   - SSH: check if ~/Projects/{repoName} exists
   - If not: git clone {repoUrl} ~/Projects/{repoName}
   - If yes: git fetch in the existing clone

3. Create worktree (or checkout branch):
   - SSH: git worktree add ~/ark-worktrees/{sessionId} {branch}
   - Or just work in the main clone if no branch

4. Sync credentials (provider.syncEnvironment):
   - Push SSH keys, AWS creds, git config, gh auth, Claude config
   - Already implemented in ec2/sync.ts

5. Sync project files (from arc.json):
   - Read arc.json from the LOCAL repo
   - Push the listed files (.env, terraform.tfvars) to the REMOTE worktree
   - Already implemented in ec2/sync.ts syncProjectFiles()

6. Pre-trust the remote directory:
   - SSH: write to ~/.claude.json on remote with hasTrustDialogAccepted: true

7. Build and upload launcher script:
   - cd to the REMOTE worktree path (not local)
   - Claude command with remote paths

8. Create remote tmux session:
   - SSH: tmux new-session -d -s {name} 'bash launcher.sh'

9. Auto-accept channel prompt:
   - Poll remote tmux pane for "I am using this for local"
   - Send Enter via SSH + tmux send-keys

10. Setup port tunnels:
    - SSH -L for declared ports
```

## File Structure

### Modified files

| File | Changes |
|------|---------|
| `packages/compute/providers/ec2/index.ts` | Rewrite `launch()` with proper remote setup |
| `packages/compute/providers/ec2/sync.ts` | Add `trustRemoteDirectory()`, `cloneRepoOnRemote()` |
| `packages/core/session.ts` | Extract git remote URL from local repo for remote dispatch |

### New files

| File | Responsibility |
|------|---------------|
| `packages/compute/providers/ec2/remote-setup.ts` | Remote repo clone, worktree, trust, launcher upload |

---

## Task 1: Extract git remote URL from local repo

**Files:**
- Create: `packages/compute/providers/ec2/remote-setup.ts`

The provider needs to know the git remote URL to clone on the remote host. If the user provides a local path like `/Users/yana/Projects/ark`, we need to extract the GitHub URL from it.

- [ ] **Step 1: Implement getGitRemoteUrl()**

```typescript
export function getGitRemoteUrl(localPath: string): string | null {
  try {
    const url = execFileSync("git", ["-C", localPath, "remote", "get-url", "origin"], {
      encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return url || null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Implement getRepoName()**

```typescript
export function getRepoName(repoUrlOrPath: string): string {
  // From URL: https://github.com/org/repo.git → repo
  // From path: /Users/yana/Projects/ark → ark
  const base = repoUrlOrPath.split("/").pop() ?? "repo";
  return base.replace(/\.git$/, "");
}
```

- [ ] **Step 3: Commit**

---

## Task 2: Remote repo setup via SSH

**Files:**
- Modify: `packages/compute/providers/ec2/remote-setup.ts`

- [ ] **Step 1: Implement cloneOrUpdateRepo()**

```typescript
export async function cloneOrUpdateRepo(
  key: string, ip: string,
  repoUrl: string, remotePath: string,
  opts?: { branch?: string; onLog?: (msg: string) => void }
): Promise<string> {
  const log = opts?.onLog ?? (() => {});

  // Check if repo exists on remote
  const { exitCode } = await sshExecAsync(key, ip, `test -d ${remotePath}/.git`);

  if (exitCode !== 0) {
    // Clone
    log(`Cloning ${repoUrl} to ${remotePath}...`);
    await sshExecAsync(key, ip, `git clone ${repoUrl} ${remotePath}`, { timeout: 120_000 });
  } else {
    // Fetch latest
    log("Fetching latest...");
    await sshExecAsync(key, ip, `cd ${remotePath} && git fetch --prune`, { timeout: 30_000 });
  }

  return remotePath;
}
```

- [ ] **Step 2: Implement createRemoteWorktree()**

```typescript
export async function createRemoteWorktree(
  key: string, ip: string,
  repoPath: string, sessionId: string, branch?: string,
): Promise<string> {
  const wtPath = `~/.ark/worktrees/${sessionId}`;
  const branchName = branch ?? `ark-${sessionId}`;

  await sshExecAsync(key, ip, `cd ${repoPath} && git worktree prune`);

  // Try new branch, then existing, then unique
  for (const args of [
    `git worktree add -b ${branchName} ${wtPath}`,
    `git worktree add ${wtPath} ${branchName}`,
    `git worktree add -b ark-${sessionId} ${wtPath}`,
  ]) {
    const { exitCode } = await sshExecAsync(key, ip, `cd ${repoPath} && ${args}`);
    if (exitCode === 0) return wtPath;
  }

  // Fallback: just use the repo directly
  return repoPath;
}
```

- [ ] **Step 3: Implement trustRemoteDirectory()**

```typescript
export async function trustRemoteDirectory(
  key: string, ip: string, remotePath: string,
): Promise<void> {
  const script = `
    FILE=~/.claude.json
    if [ ! -f "$FILE" ]; then echo '{}' > "$FILE"; fi
    node -e "
      const fs = require('fs');
      const j = JSON.parse(fs.readFileSync('$FILE','utf8'));
      if(!j.projects) j.projects={};
      j.projects['${remotePath}']={hasTrustDialogAccepted:true};
      fs.writeFileSync('$FILE',JSON.stringify(j,null,2));
    " 2>/dev/null || python3 -c "
      import json,os
      f=os.path.expanduser('~/.claude.json')
      j=json.load(open(f)) if os.path.exists(f) else {}
      j.setdefault('projects',{})['${remotePath}']={'hasTrustDialogAccepted':True}
      json.dump(j,open(f,'w'),indent=2)
    "
  `;
  await sshExecAsync(key, ip, script);
}
```

- [ ] **Step 4: Commit**

---

## Task 3: Rewrite EC2Provider.launch()

**Files:**
- Modify: `packages/compute/providers/ec2/index.ts`

The launch method should:
1. Determine remote repo URL and path
2. Clone/update repo on remote
3. Create worktree on remote
4. Sync credentials
5. Sync project files (from arc.json)
6. Trust the remote directory
7. Build launcher with REMOTE paths
8. Upload launcher and create remote tmux session
9. Auto-accept channel prompt
10. Setup port tunnels

- [ ] **Step 1: Rewrite launch()**

```typescript
async launch(host: Host, session: Session, opts: LaunchOpts): Promise<string> {
  const cfg = host.config as EC2HostConfig;
  const ip = cfg.ip;
  if (!ip) throw new Error(`Host '${host.name}' has no IP`);
  const key = sshKeyPath(host.name);

  // 1. Determine repo URL
  const repoUrl = getGitRemoteUrl(opts.workdir) ?? session.repo ?? opts.workdir;
  const repoName = getRepoName(repoUrl);
  const remotePath = `/home/ubuntu/Projects/${repoName}`;

  // 2. Clone/update
  await cloneOrUpdateRepo(key, ip, repoUrl, remotePath);

  // 3. Worktree
  const remoteWorkdir = await createRemoteWorktree(key, ip, remotePath, session.id, session.branch);

  // 4. Sync credentials (already implemented)
  await syncToHost(key, ip, { direction: "push" });

  // 5. Sync project files
  const arcJson = parseArcJson(opts.workdir);
  if (arcJson?.sync?.length) {
    await syncProjectFiles(key, ip, arcJson.sync, opts.workdir, remoteWorkdir);
  }

  // 6. Trust remote directory
  await trustRemoteDirectory(key, ip, remoteWorkdir);

  // 7. Build launcher with REMOTE paths
  const remoteLauncher = opts.launcherContent
    .replace(new RegExp(opts.workdir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), remoteWorkdir);

  // 8. Upload and launch
  const encoded = Buffer.from(remoteLauncher).toString("base64");
  const remoteDir = `~/.ark/tracks/${session.id}`;
  await sshExecAsync(key, ip, `mkdir -p ${remoteDir} && echo '${encoded}' | base64 -d > ${remoteDir}/launch.sh && chmod +x ${remoteDir}/launch.sh`);
  await sshExecAsync(key, ip, `tmux new-session -d -s ${opts.tmuxName} 'bash ${remoteDir}/launch.sh'`);

  // 9. Auto-accept channel prompt
  await autoAcceptChannelPrompt(key, ip, opts.tmuxName);

  // 10. Port tunnels
  if (opts.ports.length > 0) {
    setupTunnels(key, ip, opts.ports);
  }

  return opts.tmuxName;
}
```

- [ ] **Step 2: Update session detail to show remote workdir**

The session detail should show the REMOTE workdir, not the local one. Store it in session config after launch.

- [ ] **Step 3: Write tests**

- [ ] **Step 4: Commit**

---

## Task 4: Auto-accept channel prompt on remote

**Files:**
- Modify: `packages/compute/providers/ec2/remote-setup.ts`

- [ ] **Step 1: Implement autoAcceptChannelPrompt()**

```typescript
export async function autoAcceptChannelPrompt(
  key: string, ip: string, tmuxName: string,
): Promise<void> {
  await poll(
    async () => {
      const { stdout } = await sshExecAsync(key, ip,
        `tmux capture-pane -t ${tmuxName} -p 2>/dev/null | tail -20`);
      if (stdout.includes("I am using this for local")) {
        await sshExecAsync(key, ip, `tmux send-keys -t ${tmuxName} Enter`);
        return true;
      }
      if (stdout.includes("Welcome") || stdout.includes("Claude Code v")) return true;
      return false;
    },
    { maxAttempts: 15, delayMs: 1000 },
  );
}
```

- [ ] **Step 2: Commit**

---

## Task 5: Update session display for remote context

**Files:**
- Modify: `packages/tui/tabs/SessionsTab.tsx`
- Modify: `packages/compute/providers/ec2/index.ts`

After launch, store the remote workdir in session config so the TUI can show it:

```typescript
// After successful launch
core.updateSession(session.id, {
  config: { ...session.config, remoteWorkdir: remoteWorkdir },
});
```

In the session detail, show both local and remote paths when on EC2.

- [ ] **Step 1: Store remote workdir in session config**
- [ ] **Step 2: Display remote context in TUI**
- [ ] **Step 3: Commit**

---

## Task 6: E2E test for remote dispatch

- [ ] **Step 1: Write test that verifies full EC2 dispatch flow**

Mock or use a real EC2 host (if available). Verify:
- Repo is cloned on remote
- Worktree is created
- Credentials are synced
- Claude is running in the correct directory
- Session detail shows remote workdir

- [ ] **Step 2: Commit**

---

## Summary

| Task | What |
|------|------|
| 1 | Extract git remote URL, repo name helpers |
| 2 | Remote repo clone, worktree, trust via SSH |
| 3 | Rewrite EC2Provider.launch() with full remote setup |
| 4 | Auto-accept channel prompt on remote |
| 5 | Update session display for remote context |
| 6 | E2E test |

After this, dispatching to EC2 will:
1. Clone the repo from GitHub on the remote host
2. Create an isolated worktree for the session
3. Sync all credentials and project files
4. Pre-trust the directory so Claude doesn't prompt
5. Launch Claude in the correct remote directory
6. Show the remote workdir in the session detail
