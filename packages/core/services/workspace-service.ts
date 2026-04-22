/**
 * Worktree management -- git worktree create/remove, file copy, orphan cleanup.
 *
 * Extracted from session-orchestration.ts. All functions take app: AppContext as first arg.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { promisify } from "util";
import { execFile } from "child_process";

const execFileAsync = promisify(execFile);

/**
 * Return a safe leaf filename for a user-controlled attachment name. Strips
 * any directory components and rejects traversal payloads (`..`, separators,
 * absolute paths, NULs, control chars). Throws on unsafe input rather than
 * silently sanitizing -- callers MUST treat the returned value as authoritative.
 */
export function safeAttachmentName(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("attachment name must be a non-empty string");
  }
  // Reject NUL bytes, control chars, and path separators up front so the
  // attacker never gets a chance to smuggle a traversal past `basename()`.
  if (/[\x00-\x1f]/.test(raw)) {
    throw new Error(`unsafe attachment name (control chars): ${JSON.stringify(raw)}`);
  }
  if (raw.includes("/") || raw.includes("\\")) {
    throw new Error(`unsafe attachment name (path separator): ${JSON.stringify(raw)}`);
  }
  // `basename` is belt-and-suspenders for platform-specific edge cases.
  const cleaned = basename(raw);
  if (cleaned === "" || cleaned === "." || cleaned === "..") {
    throw new Error(`unsafe attachment name: ${JSON.stringify(raw)}`);
  }
  if (cleaned !== raw) {
    throw new Error(`unsafe attachment name (normalized mismatch): ${JSON.stringify(raw)}`);
  }
  return cleaned;
}

import type { AppContext } from "../app.js";
import type { Session, Compute } from "../../types/index.js";
import type { ComputeProvider } from "../../compute/types.js";
import * as claude from "../claude/claude.js";
import { loadRepoConfig } from "../repo-config.js";
import { logDebug, logError, logInfo, logWarn } from "../observability/structured-log.js";
import { safeAsync } from "../safe.js";

const DEFAULT_BASE_BRANCH = "main";

/** Setup git worktree + Claude trust for the session working directory. */
export async function setupSessionWorktree(
  app: AppContext,
  session: Session,
  compute: Compute | null,
  provider: ComputeProvider | undefined,
  onLog?: (msg: string) => void,
): Promise<string> {
  const log = onLog ?? (() => {});

  // Resolve the repo source path BEFORE deciding whether to worktree.
  // Previously we bailed out when workdir was "." or null -- that's exactly
  // the self-dogfood case (ark running on its own repo with --repo .), and
  // it's the most dangerous case to skip isolation for: without a worktree
  // the agent edits the live checkout and parallel dispatches collide.
  //
  // Prefer session.repo (stable source-of-truth for the upstream checkout);
  // fall back to workdir only when repo isn't set. This matters on resume:
  // a previous dispatch may have already set session.workdir to a worktree
  // path that cleanupSession then deleted -- using workdir as the source
  // would chase a dangling reference.
  const repoRaw = session.repo;
  const workdirRaw = session.workdir;
  const hasExplicitRepo = repoRaw && repoRaw !== "." && repoRaw.trim() !== "";
  const hasExplicitWorkdir = workdirRaw && workdirRaw !== "." && workdirRaw.trim() !== "";
  const repoSource = hasExplicitRepo ? resolve(repoRaw!) : hasExplicitWorkdir ? resolve(workdirRaw!) : resolve(".");

  let effectiveWorkdir = repoSource;

  // Create git worktree unless provider doesn't support it or session config explicitly disables it.
  // We worktree when repoSource is a real git repo -- even if it resolves to the current cwd
  // (that is precisely when isolation matters most for the self-dogfood loop).
  const wantWorktree = provider?.supportsWorktree === true && session.config?.worktree !== false;
  if (wantWorktree && existsSync(join(repoSource, ".git"))) {
    log("Setting up git worktree...");
    const wt = await setupWorktree(app, repoSource, session.id, session.branch ?? undefined);
    if (wt) {
      effectiveWorkdir = wt;
    } else {
      // Hard fail: silently falling back to the live checkout is dangerous.
      // Surface the error so the operator knows isolation was not achieved.
      throw new Error(
        `Failed to create git worktree for session ${session.id} from ${repoSource}. ` +
          `Refusing to dispatch against the live checkout. Check git worktree state (\`git worktree list\` in ${repoSource}) and retry.`,
      );
    }
  }

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

  // Trust worktree for Claude
  log("Configuring Claude trust + channel...");
  claude.trustWorktree(repoSource, effectiveWorkdir);

  // Persist an ABSOLUTE workdir on the session row. The previous behaviour
  // left session.workdir as null/"." when the user passed --repo ".", which
  // tripped the transcript parser into resolving an empty path against the
  // parent process cwd and attributing the wrong jsonl file. Resolving here
  // (against the dispatching process cwd, NOT the agent cwd) gives every
  // downstream observer (parser, status poller, web UI) an unambiguous
  // absolute path. Idempotent: skip the write if the row already matches.
  const persisted = resolve(effectiveWorkdir);
  if (session.workdir !== persisted) {
    await app.sessions.update(session.id, { workdir: persisted });
    (session as { workdir: string | null }).workdir = persisted;
  }

  // Materialise attachments onto the worktree. The first time through, any
  // `{ name, content, type }` entry is uploaded to tenant-scoped BlobStore
  // and replaced on the session row with `{ name, locator, type }` -- this
  // keeps subsequent dispatches + replicas reading bytes from durable
  // storage instead of trying to find ephemeral worktree files on the right
  // container. Whichever shape we see, we end with a file at
  // `<workdir>/.ark/attachments/<name>` for the agent to open.
  await materializeAttachments(app, session, effectiveWorkdir);

  return effectiveWorkdir;
}

interface AttachmentEntry {
  name: string;
  type?: string;
  /** Raw base64 / utf-8 content (legacy / pre-upload sessions). */
  content?: string;
  /** Blob locator (post-upload). */
  locator?: string;
}

/**
 * Upload any not-yet-uploaded attachments to BlobStore and materialise every
 * attachment into `<workdir>/.ark/attachments/`. On first call the session
 * row is rewritten to carry locators instead of inline base64; subsequent
 * calls are pure reads.
 */
async function materializeAttachments(app: AppContext, session: Session, workdir: string): Promise<void> {
  const raw = (session.config as any)?.attachments as AttachmentEntry[] | undefined;
  if (!raw?.length) return;

  const attachDir = join(workdir, ".ark", "attachments");
  mkdirSync(attachDir, { recursive: true });

  // Accumulate the post-upload shape so we can rewrite `config.attachments`
  // atomically at the end. If nothing needed uploading, `changed` stays false
  // and we skip the update.
  const rewritten: AttachmentEntry[] = [];
  let changed = false;

  for (const att of raw) {
    // Path-traversal guard: attacker-controlled `att.name` must not escape
    // `attachDir`. Throws on `..`, separators, absolute paths, or control
    // chars -- we log + skip rather than failing the whole dispatch.
    let safeName: string;
    try {
      safeName = safeAttachmentName(att.name);
    } catch (e: any) {
      logWarn("workspace", `skipping unsafe attachment for session ${session.id}: ${e?.message ?? e}`);
      continue;
    }

    let bytes: Buffer | null = null;
    let locator = att.locator;

    if (locator) {
      // Already uploaded: pull from BlobStore.
      try {
        const got = await app.blobStore.get(locator, session.tenant_id);
        bytes = got.bytes;
      } catch (e: any) {
        logWarn("workspace", `failed to fetch attachment ${safeName} for ${session.id}: ${e?.message ?? e}`);
        continue;
      }
    } else if (att.content) {
      // Not yet uploaded: decode, push to BlobStore, rewrite in place.
      bytes = att.content.startsWith("data:")
        ? Buffer.from(att.content.replace(/^data:[^;]+;base64,/, ""), "base64")
        : Buffer.from(att.content, "utf-8");
      const meta = await app.blobStore.put(
        { tenantId: session.tenant_id, namespace: "attachments", id: session.id, filename: safeName },
        bytes,
        { contentType: att.type },
      );
      locator = meta.locator;
      changed = true;
    } else {
      logWarn("workspace", `attachment ${safeName} has neither content nor locator; skipping`);
      continue;
    }

    writeFileSync(join(attachDir, safeName), bytes);
    rewritten.push({ name: safeName, type: att.type, locator });
  }

  if (changed) {
    // Replace the inline-content entries with locator-only entries so the
    // next dispatch + the web UI both see the same durable reference.
    // Must await: under Temporal semantics the activity can return before
    // the DB write lands, leaving the next dispatch to read the old inline
    // content. Bun resolves synchronously today but that's incidental.
    await app.sessions.mergeConfig(session.id, { attachments: rewritten });
  }
}

async function setupWorktree(
  app: AppContext,
  repoPath: string,
  sessionId: string,
  branch?: string,
): Promise<string | null> {
  const wtPath = join(app.config.worktreesDir, sessionId);
  if (existsSync(wtPath)) return wtPath;

  const branchName = branch ?? `ark-${sessionId}`;
  try {
    await execFileAsync("git", ["-C", repoPath, "worktree", "prune"], {
      encoding: "utf-8",
    });
    // Try with new branch
    try {
      await execFileAsync("git", ["-C", repoPath, "worktree", "add", "-b", branchName, wtPath], {
        encoding: "utf-8",
      });
      return wtPath;
    } catch (e: any) {
      if (!String(e).includes("already exists")) {
        logError("session", `setupWorktree: new branch '${branchName}' failed: ${e?.message ?? e}`);
      }
    }
    // Try existing branch
    try {
      await execFileAsync("git", ["-C", repoPath, "worktree", "add", wtPath, branchName], {
        encoding: "utf-8",
      });
      return wtPath;
    } catch (e: any) {
      if (!String(e).includes("already checked out") && !String(e).includes("already exists")) {
        logError("session", `setupWorktree: existing branch '${branchName}' failed: ${e?.message ?? e}`);
      }
    }
    // Unique branch
    try {
      await execFileAsync("git", ["-C", repoPath, "worktree", "add", "-b", `ark-${sessionId}`, wtPath], {
        encoding: "utf-8",
      });
      return wtPath;
    } catch (e: any) {
      logError("session", `setupWorktree: all strategies failed for ${sessionId}: ${e?.message ?? e}`);
    }
  } catch (e: any) {
    logError("session", `setupWorktree: worktree prune failed: ${e?.message ?? e}`);
  }
  return null;
}

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
    if (pattern.includes("..")) continue;

    const glob = new Bun.Glob(pattern);
    for await (const relPath of glob.scan({ cwd: sourceRepo, dot: true })) {
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

/**
 * Get a diff summary for a session's worktree branch vs its base branch.
 * Used for previewing changes before merge or PR creation.
 */
export async function worktreeDiff(
  app: AppContext,
  sessionId: string,
  opts?: {
    base?: string;
  },
): Promise<{
  ok: boolean;
  stat: string;
  diff: string;
  branch: string;
  baseBranch: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  modifiedSinceReview: string[];
  message?: string;
}> {
  const session = await app.sessions.get(sessionId);
  if (!session)
    return {
      ok: false,
      stat: "",
      diff: "",
      branch: "",
      baseBranch: "",
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      modifiedSinceReview: [],
      message: "Session not found",
    };

  const workdir = session.workdir;
  const repo = session.repo;
  if (!workdir || !repo)
    return {
      ok: false,
      stat: "",
      diff: "",
      branch: "",
      baseBranch: "",
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      modifiedSinceReview: [],
      message: "No workdir or repo",
    };

  // Determine the worktree path and branch
  const wtDir = join(app.config.worktreesDir, sessionId);
  let branch = session.branch;
  if (!branch && existsSync(wtDir)) {
    try {
      const { stdout } = await execFileAsync("git", ["-C", wtDir, "rev-parse", "--abbrev-ref", "HEAD"], {
        encoding: "utf-8",
      });
      branch = stdout.trim();
    } catch {
      logDebug("session", "worktree dir may not be a git repo yet -- branch stays undefined");
    }
  }
  if (!branch)
    return {
      ok: false,
      stat: "",
      diff: "",
      branch: "",
      baseBranch: "",
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      modifiedSinceReview: [],
      message: "Cannot determine branch",
    };

  const baseBranch = opts?.base ?? DEFAULT_BASE_BRANCH;

  try {
    // Get diff stat
    const { stdout: stat } = await execFileAsync("git", ["-C", repo, "diff", "--stat", `${baseBranch}...${branch}`], {
      encoding: "utf-8",
    });

    // Get full diff (truncated to 50KB)
    const { stdout: fullDiff } = await execFileAsync("git", ["-C", repo, "diff", `${baseBranch}...${branch}`], {
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
    });
    const diff = fullDiff.length > 50_000 ? fullDiff.slice(0, 50_000) + "\n... (truncated)" : fullDiff;

    // Parse shortstat for counts
    const { stdout: shortstat } = await execFileAsync(
      "git",
      ["-C", repo, "diff", "--shortstat", `${baseBranch}...${branch}`],
      { encoding: "utf-8" },
    );
    // "3 files changed, 42 insertions(+), 7 deletions(-)"
    const filesMatch = shortstat.match(/(\d+) files? changed/);
    const insMatch = shortstat.match(/(\d+) insertions?/);
    const delMatch = shortstat.match(/(\d+) deletions?/);

    // Track file hashes for re-review detection
    const modifiedSinceReview: string[] = [];
    try {
      const { stdout: diffNames } = await execFileAsync(
        "git",
        ["-C", repo, "diff", "--name-only", `${baseBranch}...${branch}`],
        { encoding: "utf-8" },
      );
      const files = diffNames.trim().split("\n").filter(Boolean);
      const fileHashes: Record<string, string> = {};
      for (const file of files) {
        try {
          const { stdout: hash } = await execFileAsync("git", ["-C", repo, "rev-parse", `${branch}:${file}`], {
            encoding: "utf-8",
          });
          fileHashes[file] = hash.trim();
        } catch {
          logInfo("session", "file may have been deleted");
        }
      }

      // Compare against previously reviewed hashes
      const prevSessionForReview = await app.sessions.get(sessionId);
      const prevReviewed = prevSessionForReview?.config?.reviewed_files as Record<string, string> | undefined;
      if (prevReviewed) {
        for (const file of files) {
          if (prevReviewed[file] && prevReviewed[file] !== fileHashes[file]) {
            modifiedSinceReview.push(file);
          }
        }
      }

      // Save current hashes as reviewed. Must await: under Temporal
      // semantics the activity can return before the DB write lands, so the
      // next worktreeDiff would read stale hashes and mis-report
      // modifiedSinceReview. Bun resolves synchronously today but that's
      // incidental.
      await app.sessions.mergeConfig(sessionId, { reviewed_files: fileHashes });
    } catch {
      logDebug("session", "re-review tracking is best-effort");
    }

    return {
      ok: true,
      stat,
      diff,
      branch,
      baseBranch,
      filesChanged: filesMatch ? parseInt(filesMatch[1]) : 0,
      insertions: insMatch ? parseInt(insMatch[1]) : 0,
      deletions: delMatch ? parseInt(delMatch[1]) : 0,
      modifiedSinceReview,
    };
  } catch (e: any) {
    return {
      ok: false,
      stat: "",
      diff: "",
      branch,
      baseBranch,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      modifiedSinceReview: [],
      message: e?.message ?? "Diff failed",
    };
  }
}

/**
 * Rebase the session branch onto the base branch before PR creation.
 * Fetches origin, then rebases onto origin/<base>. On conflict, aborts
 * the rebase and returns an error -- the branch is left unchanged.
 */
export async function rebaseOntoBase(
  app: AppContext,
  sessionId: string,
  opts?: {
    base?: string;
  },
): Promise<{ ok: boolean; message: string }> {
  const session = await app.sessions.get(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };

  const repo = session.repo;
  if (!repo) return { ok: false, message: "Session has no repo" };

  const wtDir = join(app.config.worktreesDir, sessionId);
  const gitDir = existsSync(wtDir) ? wtDir : repo;
  const base = opts?.base ?? DEFAULT_BASE_BRANCH;

  try {
    // Fetch latest from origin so rebase target is up to date
    await execFileAsync("git", ["-C", gitDir, "fetch", "origin", base], {
      encoding: "utf-8",
      timeout: 30_000,
    });

    // Rebase onto origin/<base>
    await execFileAsync("git", ["-C", gitDir, "rebase", `origin/${base}`], {
      encoding: "utf-8",
      timeout: 60_000,
    });

    await app.events.log(sessionId, "rebase_completed", {
      stage: session.stage ?? undefined,
      actor: "system",
      data: { base },
    });

    return { ok: true, message: `Rebased onto origin/${base}` };
  } catch (e: any) {
    // Abort the rebase to leave the branch in its original state
    try {
      await execFileAsync("git", ["-C", gitDir, "rebase", "--abort"], {
        encoding: "utf-8",
      });
    } catch {
      logDebug("session", "already clean");
    }

    logWarn("session", `rebaseOntoBase: rebase failed for ${sessionId}: ${e?.message ?? e}`);
    return { ok: false, message: `Rebase failed: ${e?.message ?? e}` };
  }
}

/**
 * Create a GitHub PR from a session's worktree branch.
 * Optionally rebases onto the base branch first (controlled by repo config auto_rebase, default true).
 * Pushes the branch and creates the PR via gh CLI.
 */
export async function createWorktreePR(
  app: AppContext,
  sessionId: string,
  opts?: {
    title?: string;
    body?: string;
    base?: string;
    draft?: boolean;
  },
): Promise<{ ok: boolean; message: string; pr_url?: string }> {
  const session = await app.sessions.get(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };

  const repo = session.repo;
  if (!repo) return { ok: false, message: "Session has no repo" };

  // Determine branch
  const wtDir = join(app.config.worktreesDir, sessionId);
  let branch = session.branch;
  if (!branch && existsSync(wtDir)) {
    try {
      const { stdout } = await execFileAsync("git", ["-C", wtDir, "rev-parse", "--abbrev-ref", "HEAD"], {
        encoding: "utf-8",
      });
      branch = stdout.trim();
    } catch {
      logDebug("session", "worktree dir may not be a git repo yet -- branch stays undefined");
    }
  }
  if (!branch) return { ok: false, message: "Cannot determine worktree branch" };

  const base = opts?.base ?? DEFAULT_BASE_BRANCH;
  const title = opts?.title ?? session.summary ?? `ark: ${sessionId}`;
  const body = opts?.body ?? `Session: ${sessionId}\nFlow: ${session.flow}\nAgent: ${session.agent ?? "default"}`;

  // Auto-rebase onto base branch (unless disabled in repo config)
  const repoConfig = session.workdir ? loadRepoConfig(session.workdir) : {};
  if (repoConfig.auto_rebase !== false) {
    const rebaseResult = await rebaseOntoBase(app, sessionId, { base });
    if (!rebaseResult.ok) {
      // Rebase failed (conflict) -- still proceed with PR creation without rebase.
      // The PR will show merge conflicts on GitHub, which is preferable to blocking.
      logWarn(
        "session",
        `createWorktreePR: auto-rebase failed for ${sessionId}, proceeding without rebase: ${rebaseResult.message}`,
      );
    }
  }

  try {
    // 1. Push branch
    const pushDir = existsSync(wtDir) ? wtDir : repo;
    await execFileAsync("git", ["-C", pushDir, "push", "-u", "origin", branch], { encoding: "utf-8", timeout: 30_000 });

    // 2. Create PR via gh CLI
    const ghArgs = ["pr", "create", "--repo", repo, "--head", branch, "--base", base, "--title", title, "--body", body];
    if (opts?.draft) ghArgs.push("--draft");
    const { stdout } = await execFileAsync("gh", ghArgs, { encoding: "utf-8", timeout: 30_000, cwd: pushDir });
    const prUrl = stdout.trim();

    // 3. Store PR URL on session
    await app.sessions.update(sessionId, { pr_url: prUrl });
    await app.events.log(sessionId, "pr_created", {
      stage: session.stage ?? undefined,
      actor: "user",
      data: { pr_url: prUrl, branch, base, draft: opts?.draft ?? false },
    });

    return { ok: true, message: `PR created: ${prUrl}`, pr_url: prUrl };
  } catch (e: any) {
    return { ok: false, message: `PR creation failed: ${e?.message ?? e}` };
  }
}

/**
 * Merge an existing PR via `gh pr merge`. Used by the auto_merge action stage.
 * Requires the session to have a pr_url (set by a preceding create_pr stage).
 */
export async function mergeWorktreePR(
  app: AppContext,
  sessionId: string,
  opts?: {
    method?: "merge" | "squash" | "rebase";
    deleteAfter?: boolean;
  },
): Promise<{ ok: boolean; message: string }> {
  const session = await app.sessions.get(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };

  const prUrl = session.pr_url;
  if (!prUrl) return { ok: false, message: "Session has no PR URL -- run create_pr first" };

  const repo = session.repo;
  if (!repo) return { ok: false, message: "Session has no repo" };

  const method = opts?.method ?? "squash";
  const deleteAfter = opts?.deleteAfter ?? true;

  try {
    const ghArgs = ["pr", "merge", prUrl, `--${method}`, "--auto"];
    if (deleteAfter) ghArgs.push("--delete-branch");
    const cwd = session.workdir ?? repo;
    await execFileAsync("gh", ghArgs, { encoding: "utf-8", timeout: 30_000, cwd });

    await app.events.log(sessionId, "pr_merged", {
      stage: session.stage ?? undefined,
      actor: "system",
      data: { pr_url: prUrl, method, delete_branch: deleteAfter },
    });

    return { ok: true, message: `PR merge initiated: ${prUrl}` };
  } catch (e: any) {
    return { ok: false, message: `PR merge failed: ${e?.message ?? e}` };
  }
}

/**
 * Finish a worktree session: merge branch into target, remove worktree, delete session.
 * Aborts safely on merge conflict without losing work.
 *
 * NOTE: This function has a forward dependency on deleteSessionAsync from session-lifecycle.
 * It is injected at runtime to avoid circular imports.
 */
let _deleteSessionAsync: ((app: AppContext, sessionId: string) => Promise<{ ok: boolean; message: string }>) | null =
  null;
let _stop:
  | ((app: AppContext, sessionId: string, opts?: { force?: boolean }) => Promise<{ ok: boolean; message: string }>)
  | null = null;
let _runVerification: ((app: AppContext, sessionId: string) => Promise<any>) | null = null;

export function injectWorktreeDeps(deps: {
  deleteSessionAsync: typeof _deleteSessionAsync;
  stop: typeof _stop;
  runVerification: typeof _runVerification;
}): void {
  _deleteSessionAsync = deps.deleteSessionAsync;
  _stop = deps.stop;
  _runVerification = deps.runVerification;
}

export async function finishWorktree(
  app: AppContext,
  sessionId: string,
  opts?: {
    into?: string;
    noMerge?: boolean;
    keepBranch?: boolean;
    createPR?: boolean;
    force?: boolean;
  },
): Promise<{ ok: boolean; message: string }> {
  const session = await app.sessions.get(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };

  const workdir = session.workdir;
  const repo = session.repo;
  if (!workdir || !repo)
    return {
      ok: false,
      message: "Session has no workdir or repo. Create a new session with --repo to enable worktree features.",
    };

  // Verify before finishing (unless force)
  if (!opts?.force && _runVerification) {
    const verify = await _runVerification(app, sessionId);
    if (!verify.ok) {
      return { ok: false, message: `Cannot finish: verification failed:\n${verify.message}` };
    }
  }

  // Determine the worktree path and branch
  const wtDir = join(app.config.worktreesDir, sessionId);
  const isWorktree = existsSync(wtDir);

  // Get the branch name from the worktree
  let branch: string | null = session.branch;
  if (!branch && isWorktree) {
    try {
      const { stdout } = await execFileAsync("git", ["-C", wtDir, "rev-parse", "--abbrev-ref", "HEAD"], {
        encoding: "utf-8",
      });
      branch = stdout.trim();
    } catch {
      logDebug("session", "worktree dir may not be a git repo yet -- branch stays undefined");
    }
  }

  if (!branch) return { ok: false, message: "Cannot determine worktree branch" };

  const targetBranch = opts?.into ?? DEFAULT_BASE_BRANCH;

  // 1. Stop the session if running
  if (!["completed", "failed", "stopped", "pending"].includes(session.status) && _stop) {
    await _stop(app, sessionId);
  }

  // 1b. Create PR instead of merging locally if requested
  if (opts?.createPR) {
    const prResult = await createWorktreePR(app, sessionId, {
      base: targetBranch,
      title: session.summary ?? undefined,
    });
    if (!prResult.ok) return prResult;
    // Still cleanup worktree after PR creation
    if (isWorktree) {
      try {
        await execFileAsync("git", ["-C", repo, "worktree", "remove", wtDir, "--force"], {
          encoding: "utf-8",
        });
      } catch (e: any) {
        logError("session", `finishWorktree: remove worktree failed: ${e?.message ?? e}`);
      }
    }
    if (_deleteSessionAsync) await _deleteSessionAsync(app, sessionId);
    await app.events.log(sessionId, "worktree_finished", {
      actor: "user",
      data: { branch, targetBranch, merged: false, pr: true },
    });
    return { ok: true, message: `PR created and worktree cleaned up. ${prResult.pr_url ?? ""}`.trim() };
  }

  // 2. Merge branch into target (unless --no-merge)
  if (!opts?.noMerge) {
    try {
      // Checkout target branch in the main repo
      await execFileAsync("git", ["-C", repo, "checkout", targetBranch], {
        encoding: "utf-8",
      });
      // Merge the worktree branch
      await execFileAsync("git", ["-C", repo, "merge", branch, "--no-edit"], {
        encoding: "utf-8",
      });
    } catch {
      // Abort merge on conflict to preserve state
      try {
        await execFileAsync("git", ["-C", repo, "merge", "--abort"], {
          encoding: "utf-8",
        });
      } catch {
        logDebug("session", "merge --abort may fail if no merge in progress -- safe to ignore");
      }
      return {
        ok: false,
        message: `Merge conflict: ${branch} into ${targetBranch}. Resolve manually. Worktree preserved.`,
      };
    }
  }

  // 3. Remove worktree
  if (isWorktree) {
    try {
      await execFileAsync("git", ["-C", repo, "worktree", "remove", wtDir, "--force"], {
        encoding: "utf-8",
      });
    } catch (e: any) {
      logError("session", `finishWorktree: remove worktree failed: ${e?.message ?? e}`);
    }
  }

  // 4. Delete branch (unless --keep-branch)
  if (!opts?.keepBranch && branch !== targetBranch) {
    try {
      await execFileAsync("git", ["-C", repo, "branch", "-d", branch], {
        encoding: "utf-8",
      });
    } catch {
      // Branch may not exist or not be fully merged -- try force delete
      try {
        await execFileAsync("git", ["-C", repo, "branch", "-D", branch], {
          encoding: "utf-8",
        });
      } catch {
        logDebug("session", "force delete also failed -- branch may already be gone");
      }
    }
  }

  // 5. Delete the session
  if (_deleteSessionAsync) await _deleteSessionAsync(app, sessionId);

  const mergeMsg = opts?.noMerge ? "skipped merge" : `merged ${branch} -> ${targetBranch}`;
  await app.events.log(sessionId, "worktree_finished", {
    actor: "user",
    data: { branch, targetBranch, merged: !opts?.noMerge },
  });

  return { ok: true, message: `Finished: ${mergeMsg}, worktree removed, session deleted` };
}

/**
 * Remove the worktree directory for a session, if it exists.
 * Provider-independent -- called from stop() and deleteSessionAsync() so
 * worktrees are always cleaned up regardless of compute provider availability.
 */
export async function removeSessionWorktree(app: AppContext, session: Session): Promise<void> {
  const wtPath = join(app.config.worktreesDir, session.id);
  if (!existsSync(wtPath)) return;

  // Try git worktree remove first (cleans up .git/worktrees metadata)
  const repo = session.repo ?? session.workdir;
  if (repo) {
    try {
      await execFileAsync("git", ["-C", repo, "worktree", "remove", "--force", wtPath], {
        encoding: "utf-8",
      });
      return;
    } catch {
      logDebug("session", "fall through to rmSync");
    }
  }

  // Fallback: direct removal (no repo context or git worktree remove failed)
  await safeAsync(`removeSessionWorktree: rmSync ${session.id}`, async () => {
    rmSync(wtPath, { recursive: true, force: true });
  });
}

/** Find orphaned worktrees -- worktree dirs with no matching session. */
export async function findOrphanedWorktrees(app: AppContext): Promise<string[]> {
  const wtDir = app.config.worktreesDir;
  if (!existsSync(wtDir)) return [];

  const sessionIds = new Set((await app.sessions.list({ limit: 1000 })).map((s) => s.id));
  const orphans: string[] = [];

  try {
    for (const entry of readdirSync(wtDir)) {
      if (!sessionIds.has(entry)) {
        orphans.push(entry);
      }
    }
  } catch {
    logDebug("session", "worktrees dir may not exist -- no orphans to report");
  }

  return orphans;
}

/** Remove orphaned worktrees. Returns count of removed. */
export async function cleanupWorktrees(app: AppContext): Promise<{ removed: number; errors: string[] }> {
  const orphans = await findOrphanedWorktrees(app);
  let removed = 0;
  const errors: string[] = [];

  for (const id of orphans) {
    const wtPath = join(app.config.worktreesDir, id);
    try {
      // Try git worktree remove first
      await execFileAsync("git", ["worktree", "remove", wtPath, "--force"], {
        encoding: "utf-8",
      });
      removed++;
    } catch {
      // Fallback: just remove the directory
      try {
        rmSync(wtPath, { recursive: true, force: true });
        removed++;
      } catch (e: any) {
        errors.push(`${id}: ${e.message}`);
      }
    }
  }

  return { removed, errors };
}
