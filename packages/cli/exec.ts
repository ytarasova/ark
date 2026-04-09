import chalk from "chalk";
import { resolve, basename } from "path";
import { existsSync } from "fs";
import * as core from "../core/index.js";

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
}

export async function execSession(opts: ExecOpts): Promise<number> {
  const output = opts.output ?? "text";
  const log = output === "text" ? (msg: string) => process.stderr.write(chalk.dim(msg) + "\n") : () => {};

  // Resolve repo
  let workdir: string | undefined;
  let repo = opts.repo ?? ".";
  const rp = resolve(repo);
  if (existsSync(rp)) {
    workdir = rp;
    if (repo === "." || repo === "./") repo = basename(rp);
  }

  // Sanitize summary
  const rawSummary = opts.summary ?? opts.ticket ?? `exec-${Date.now()}`;
  const summary = rawSummary.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || rawSummary;

  // Create session
  log(`Creating session: ${summary}`);
  const session = core.startSession(core.getApp(), {
    ticket: opts.ticket,
    summary,
    repo,
    workdir,
    flow: opts.flow ?? "bare",
    compute_name: opts.compute,
    group_name: opts.group,
  });

  // Dispatch
  log(`Dispatching ${session.id}...`);
  const result = await core.dispatch(core.getApp(), session.id);
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
  const { session: final, timedOut } = await core.waitForCompletion(core.getApp(), session.id, {
    timeoutMs,
    pollMs: 5000,
    onStatus: (status) => log(`  Status: ${status}`),
  });

  // Result
  if (output === "json") {
    const usage = final.config?.usage;
    console.log(JSON.stringify({
      status: timedOut ? "timeout" : final.status,
      sessionId: final.id,
      flow: final.flow,
      stage: final.stage,
      error: final.error ?? null,
      usage: usage ?? null,
    }));
  } else {
    if (timedOut) {
      console.error(chalk.yellow(`Timeout after ${opts.timeout}s`));
    } else if (final.status === "completed") {
      console.log(chalk.green(`Completed`));
      const usage = final.config?.usage;
      if (usage) console.log(chalk.dim(`  Tokens: ${(usage.total_tokens / 1000).toFixed(1)}K`));
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
