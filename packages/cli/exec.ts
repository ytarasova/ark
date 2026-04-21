import chalk from "chalk";
import { resolve } from "path";
import { existsSync, statSync } from "fs";
import { startSession, dispatch, waitForCompletion } from "../core/services/session-orchestration.js";
import { DEFAULT_TENANT_ID } from "../core/code-intel/constants.js";
import type { AppContext } from "../core/app.js";

export interface ExecOpts {
  repo?: string;
  summary?: string;
  ticket?: string;
  flow?: string;
  compute?: string;
  group?: string;
  autonomy?: string;
  output?: "text" | "json";
  timeout?: number;
  /** role=path pairs. Paths are resolved relative to process.cwd(). */
  inputs?: string[];
  /** key=value pairs. */
  params?: string[];
  /**
   * Workspace slug for workspace-scoped dispatch. Resolves via
   * `CodeIntelStore.getWorkspaceBySlug`. When set with `--repo`, the repo
   * becomes the primary entry-point and the session still gets a
   * multi-repo workdir. Wave 2b-1 supports LOCAL compute only.
   */
  workspace?: string;
}

export function parsePair(pair: string, flag: string): [string, string] {
  const eq = pair.indexOf("=");
  if (eq <= 0) {
    throw new Error(`${flag} expects <key>=<value>, got: ${pair}`);
  }
  const key = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1);
  if (!key) throw new Error(`${flag} has empty key: ${pair}`);
  return [key, value];
}

export function parseInputs(raw: string[] | undefined): Record<string, string> | undefined {
  if (!raw?.length) return undefined;
  const files: Record<string, string> = {};
  for (const pair of raw) {
    const [role, relPath] = parsePair(pair, "--input");
    const abs = resolve(relPath);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      throw new Error(`--input ${role}: file not found at ${abs}`);
    }
    files[role] = abs;
  }
  return files;
}

export function parseParams(raw: string[] | undefined): Record<string, string> | undefined {
  if (!raw?.length) return undefined;
  const params: Record<string, string> = {};
  for (const pair of raw) {
    const [key, value] = parsePair(pair, "--param");
    params[key] = value;
  }
  return params;
}

export async function execSession(app: AppContext, opts: ExecOpts): Promise<number> {
  const output = opts.output ?? "text";
  const log = output === "text" ? (msg: string) => process.stderr.write(chalk.dim(msg) + "\n") : () => {};

  // Resolve workspace (Wave 2b-1). Tenant defaults to the caller's default
  // when not otherwise scoped. Resolution fails loudly so the operator
  // knows the slug was wrong before a session row is created.
  let workspace_id: string | null = null;
  if (opts.workspace) {
    const tenantSlug = app.config.authSection.defaultTenant;
    let tenantId = DEFAULT_TENANT_ID;
    if (tenantSlug) {
      const t = await app.codeIntel.getTenantBySlug(tenantSlug);
      if (t) tenantId = t.id;
    }
    const ws = await app.codeIntel.getWorkspaceBySlug(tenantId, opts.workspace);
    if (!ws) {
      console.error(chalk.red(`Workspace '${opts.workspace}' not found in tenant '${tenantSlug ?? "default"}'.`));
      return 1;
    }
    workspace_id = ws.id;
  }

  // Resolve repo. When `--workspace` is passed alone (no --repo), we skip
  // the repo-dir resolution entirely -- the session's workdir will be the
  // multi-repo workspace tree. Otherwise preserve legacy semantics:
  // absolute repo path becomes the workdir.
  let workdir: string | undefined;
  let repo: string | undefined = opts.repo;
  if (!workspace_id || opts.repo) {
    repo = opts.repo ?? ".";
    const rp = resolve(repo);
    if (existsSync(rp)) {
      workdir = rp;
      if (repo === "." || repo === "./") repo = rp;
    }
  }

  // Sanitize summary
  const rawSummary = opts.summary ?? opts.ticket ?? `exec-${Date.now()}`;
  const summary =
    rawSummary
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || rawSummary;

  // Parse --input / --param before session creation so errors surface early.
  const files = parseInputs(opts.inputs);
  const params = parseParams(opts.params);
  const inputs = files || params ? { ...(files ? { files } : {}), ...(params ? { params } : {}) } : undefined;

  // Create session
  log(`Creating session: ${summary}`);
  const session = await startSession(app, {
    ticket: opts.ticket,
    summary,
    repo,
    workdir,
    flow: opts.flow ?? "bare",
    compute_name: opts.compute,
    group_name: opts.group,
    inputs,
    workspace_id,
  });

  // Dispatch
  log(`Dispatching ${session.id}...`);
  const result = await dispatch(app, session.id);
  if (!result.ok) {
    if (output === "json") {
      console.log(JSON.stringify({ status: "error", message: result.message, sessionId: session.id }));
    } else {
      console.error(chalk.red(`Dispatch failed: ${result.message}`));
    }
    return 1;
  }
  log(`Agent running`);

  // Wait
  const timeoutMs = (opts.timeout ?? 0) * 1000;
  const { session: final, timedOut } = await waitForCompletion(app, session.id, {
    timeoutMs,
    pollMs: 5000,
    onStatus: (status) => log(`  Status: ${status}`),
  });

  // Result
  if (output === "json") {
    const usage = final.config?.usage;
    console.log(
      JSON.stringify({
        status: timedOut ? "timeout" : final.status,
        sessionId: final.id,
        flow: final.flow,
        stage: final.stage,
        error: final.error ?? null,
        usage: usage ?? null,
      }),
    );
  } else {
    if (timedOut) {
      console.error(chalk.yellow(`Timeout after ${opts.timeout}s`));
    } else if (final.status === "completed") {
      console.log(chalk.green(`Completed`));
      const usage = final.config?.usage;
      if (usage) console.log(chalk.dim(`  Tokens: ${((usage as any).total_tokens / 1000).toFixed(1)}K`));
    } else if (final.status === "failed") {
      console.error(chalk.red(`Failed: ${final.error ?? "unknown"}`));
    } else {
      console.log(chalk.yellow(`Ended: ${final.status}`));
    }
  }

  if (timedOut) return 2;
  if (final.status === "completed") return 0;
  return 1;
}
