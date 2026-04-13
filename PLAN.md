# PLAN: Worktree Untracked File Setup

## Summary

Git worktrees only contain tracked files, so agents dispatched into worktrees lose access to untracked files like `.env`, `.envrc`, `config/local.yaml`, and other local config. This feature adds a `worktree.copy` glob list and an optional `worktree.setup` script hook to `.ark.yaml` (RepoConfig), allowing repos to declare which untracked files should be copied into worktrees and what setup commands to run after worktree creation.

## Files to modify/create

| File | Change |
|------|--------|
| `packages/core/repo-config.ts` | Add `worktree?: { copy?: string[]; setup?: string }` to `RepoConfig` interface |
| `packages/core/services/session-orchestration.ts` | Add `copyWorktreeFiles()` and `runWorktreeSetup()` helpers; call them from `setupSessionWorktree()` after worktree creation (around line 1394) |
| `packages/core/__tests__/worktree-setup.test.ts` | **CREATE** -- new test file for copy-glob and setup-script behavior |
| `packages/core/__tests__/repo-config.test.ts` | Add tests for parsing `worktree.copy` and `worktree.setup` from YAML |

## Implementation steps

### Step 1: Extend `RepoConfig` with worktree settings

In `packages/core/repo-config.ts` (line 5-14), add to the `RepoConfig` interface:

```ts
export interface RepoConfig {
  flow?: string;
  compute?: string;
  group?: string;
  agent?: string;
  env?: Record<string, string>;
  verify?: string[];
  auto_pr?: boolean;
  auto_rebase?: boolean;
  worktree?: {
    copy?: string[];   // Glob patterns for untracked files to copy (e.g. [".env", ".envrc", "config/*.yaml"])
    setup?: string;    // Shell command to run after worktree creation (e.g. "cp .env.example .env && bun install")
  };
}
```

No parsing changes needed -- `YAML.parse` already handles nested objects transparently.

### Step 2: Add `copyWorktreeFiles()` helper

In `packages/core/services/session-orchestration.ts`, add a new exported function near the existing `setupWorktree()` function (after line ~1770):

```ts
/**
 * Copy untracked files matching glob patterns from source repo into worktree.
 * Only copies files that exist in the source but NOT in the worktree (avoids
 * overwriting tracked files that git already placed).
 */
export async function copyWorktreeFiles(
  sourceRepo: string,
  worktreeDir: string,
  patterns: string[],
): Promise<string[]> {
  const copied: string[] = [];
  for (const pattern of patterns) {
    // Security: reject patterns with path traversal
    if (pattern.includes("..")) continue;

    const glob = new Bun.Glob(pattern);
    for await (const relPath of glob.scan({ cwd: sourceRepo, dot: true })) {
      // Skip if file already exists in worktree (tracked files placed by git)
      const target = join(worktreeDir, relPath);
      if (existsSync(target)) continue;

      const source = join(sourceRepo, relPath);
      mkdirSync(dirname(target), { recursive: true });
      const content = readFileSync(source);
      writeFileSync(target, content);
      copied.push(relPath);
    }
  }
  return copied;
}
```

Add `dirname` to the existing `import { join, resolve } from "path"` (it already imports `join` and `resolve`; add `dirname`).

Uses `Bun.Glob` which is natively available (Bun-only project per CLAUDE.md). The `dot: true` option ensures dotfiles like `.env` are matched.

### Step 3: Add `runWorktreeSetup()` helper

In `packages/core/services/session-orchestration.ts`, add near the copy helper:

```ts
/**
 * Run a setup script in the worktree directory after file copy.
 * Times out after 60 seconds. Errors are logged but do not fail dispatch.
 */
export async function runWorktreeSetup(
  worktreeDir: string,
  command: string,
  onLog?: (msg: string) => void,
): Promise<void> {
  try {
    const { stdout, stderr } = await execFileAsync("sh", ["-c", command], {
      cwd: worktreeDir,
      timeout: 60_000,
      encoding: "utf-8",
    });
    if (stdout?.trim()) onLog?.(`setup stdout: ${stdout.trim().slice(0, 500)}`);
    if (stderr?.trim()) onLog?.(`setup stderr: ${stderr.trim().slice(0, 500)}`);
  } catch (e: any) {
    onLog?.(`Worktree setup script failed (non-fatal): ${e?.message ?? e}`);
  }
}
```

### Step 4: Wire into `setupSessionWorktree()`

In `setupSessionWorktree()` (lines 1357-1425 of `session-orchestration.ts`), insert the copy+setup calls after the worktree is created and before the trust configuration. Specifically, after line 1404 (the closing brace of the `if (wantWorktree ...)` block) and before line 1407 (`// Trust worktree for Claude`):

```ts
  // Copy untracked files + run setup from .ark.yaml worktree config
  if (effectiveWorkdir !== repoSource) {
    const repoConfig = loadRepoConfig(repoSource);
    if (repoConfig.worktree?.copy?.length) {
      log("Copying untracked files to worktree...");
      const copied = await copyWorktreeFiles(repoSource, effectiveWorkdir, repoConfig.worktree.copy);
      if (copied.length > 0) {
        log(`Copied ${copied.length} file(s): ${copied.slice(0, 5).join(", ")}${copied.length > 5 ? "..." : ""}`);
      }
    }
    if (repoConfig.worktree?.setup) {
      log("Running worktree setup script...");
      await runWorktreeSetup(effectiveWorkdir, repoConfig.worktree.setup, log);
    }
  }
```

The `repoConfig` is loaded from `repoSource` (the original repo checkout), not the worktree. The `.ark.yaml` is tracked so it exists in both, but `repoSource` is the canonical reference.

### Step 5: Add unit tests for helpers

Create `packages/core/__tests__/worktree-setup.test.ts`:

1. **copies matching untracked files** -- create temp "repo" dir with `.env` and `config/local.yaml`, empty "worktree" dir. Call `copyWorktreeFiles`. Assert files copied with correct content and directory structure.

2. **skips files that already exist in worktree** -- pre-populate worktree with `.env` containing different content. Assert original is NOT overwritten.

3. **handles nested glob patterns** -- test patterns like `config/**/*.yaml`, `secrets/*.key`.

4. **rejects `..` traversal** -- pattern `../../etc/passwd` should be silently skipped.

5. **handles no matches gracefully** -- pattern `*.nonexistent` returns empty array.

6. **runWorktreeSetup executes command in worktree dir** -- run `echo hello > marker.txt`, assert file exists.

7. **runWorktreeSetup is non-fatal on failure** -- run a command that exits non-zero, assert no exception thrown.

### Step 6: Add config parsing tests

In `packages/core/__tests__/repo-config.test.ts`, add:

8. **parses worktree.copy list** -- YAML `worktree:\n  copy:\n    - ".env"\n    - "config/*.yaml"` produces correct structure.

9. **parses worktree.setup string** -- YAML `worktree:\n  setup: "bun install"` produces correct structure.

10. **handles partial worktree config** -- only `copy` without `setup`, and vice versa.

## Testing strategy

- **Unit tests**: `copyWorktreeFiles` and `runWorktreeSetup` are standalone functions testable with temp directories. No AppContext or git repo needed.
- **Config parsing**: Extend existing `repo-config.test.ts` with worktree field cases.
- **Integration**: The wiring into `setupSessionWorktree` is verified indirectly through the existing dispatch flow. The unit tests for the helpers provide sufficient coverage for the new logic.
- **Manual verification**: Dispatch a session against a repo with `.ark.yaml` containing `worktree:\n  copy: [".env"]` and confirm the `.env` appears in the worktree.

Run:
```bash
make test-file F=packages/core/__tests__/worktree-setup.test.ts
make test-file F=packages/core/__tests__/repo-config.test.ts
make test
```

## Risk assessment

| Risk | Mitigation |
|------|------------|
| **Glob patterns copy sensitive files unintentionally** | Patterns are explicit opt-in via `.ark.yaml`. No default copying. Users declare exactly what to copy. |
| **Path traversal via `..` in patterns** | Reject patterns containing `..` segments. Only copy files within the source repo root. |
| **Large files or many matches slow dispatch** | `Bun.Glob` scan is fast. Patterns should be specific. Copied count is logged for observability. |
| **Setup script hangs** | 60-second timeout on `execFileAsync`. Non-fatal -- error logged and dispatch continues. |
| **Setup script has side effects beyond worktree** | Runs with `cwd` set to worktree. User responsibility to scope commands appropriately. |
| **Breaking changes** | None. New optional field on `RepoConfig`. Existing configs without `worktree` key are unaffected. Existing `setupSessionWorktree` behavior unchanged when no `worktree` config is present. |
| **Symlinks in source repo** | `readFileSync`/`writeFileSync` follows symlinks and copies content. This is the correct behavior -- the worktree gets real files. |

## Open questions

1. **Should `worktree.copy` support negation patterns?** (e.g., `!.env.production` to exclude from a broader `*.env` pattern). Recommendation: defer -- users can write specific patterns. Negation adds complexity for minimal gain.

2. **Should copied files be auto-added to `.gitignore` in the worktree?** Recommendation: no -- the source repo already has these files untracked (via its own `.gitignore`), and the worktree inherits the same `.gitignore` rules.

3. **Should there be a global `~/.ark/config.yaml` equivalent for `worktree.copy`?** Some env files are user-global, not repo-specific. Recommendation: defer -- repo-level `.ark.yaml` covers the primary use case (project-specific config files).
