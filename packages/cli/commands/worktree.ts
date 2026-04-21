import type { Command } from "commander";
import chalk from "chalk";
import { join } from "path";
import { existsSync } from "fs";
import { findOrphanedWorktrees, cleanupWorktrees } from "../../core/services/session-orchestration.js";
import { getArkClient } from "./_shared.js";
import type { AppContext } from "../../core/app.js";

export function registerWorktreeCommands(program: Command, app: AppContext) {
  const worktree = program.command("worktree").description("Git worktree operations");

  worktree
    .command("diff")
    .description("Preview changes in a session worktree")
    .argument("<session-id>", "Session ID")
    .option("--base <branch>", "Base branch to compare against", "main")
    .action(async (id: string, opts: any) => {
      const ark = await getArkClient();
      const result = await ark.worktreeDiff(id, { base: opts.base });
      if (!result.ok) {
        console.log(chalk.red(result.message || "Failed to get diff"));
        return;
      }
      console.log(chalk.bold(`${result.branch} vs ${result.baseBranch}`));
      console.log(
        chalk.green(`+${result.insertions}`) +
          " " +
          chalk.red(`-${result.deletions}`) +
          ` (${result.filesChanged} files)`,
      );
      if (result.modifiedSinceReview?.length > 0) {
        console.log();
        console.log(chalk.yellow(`Modified since last review:`));
        for (const f of result.modifiedSinceReview) {
          console.log(chalk.yellow(`  ! ${f}`));
        }
      }
      console.log();
      console.log(result.stat);
    });

  worktree
    .command("finish")
    .description("Merge worktree branch, remove worktree, delete session")
    .argument("<session-id>")
    .option("--into <branch>", "Target branch to merge into", "main")
    .option("--no-merge", "Skip merge, just remove worktree and delete session")
    .option("--keep-branch", "Don't delete the branch after merge")
    .action(async (sessionId: string, opts: any) => {
      const ark = await getArkClient();
      const result = await ark.worktreeFinish(sessionId, { noMerge: opts.noMerge });
      console.log(result.ok ? chalk.green(result.message) : chalk.red(result.message));
    });

  worktree
    .command("pr")
    .description("Create a GitHub PR from a session worktree")
    .argument("<session-id>", "Session ID")
    .option("--title <title>", "PR title")
    .option("--base <branch>", "Base branch", "main")
    .option("--draft", "Create as draft PR")
    .action(async (id: string, opts: any) => {
      const ark = await getArkClient();
      const result = await ark.worktreeCreatePR(id, {
        title: opts.title,
        base: opts.base,
        draft: opts.draft,
      });
      if (result.ok) {
        console.log(chalk.green(result.message));
        if (result.pr_url) console.log(chalk.cyan(result.pr_url));
      } else {
        console.log(chalk.red(result.message));
      }
    });

  worktree
    .command("list")
    .description("List sessions with active worktrees")
    .action(async () => {
      const ark = await getArkClient();
      const sessions = await ark.sessionList({ limit: 500 });
      const withWorktrees = sessions.filter((s) => {
        const wtDir = join(app.config.worktreesDir, s.id);
        return existsSync(wtDir);
      });

      if (withWorktrees.length === 0) {
        console.log(chalk.dim("No sessions with active worktrees"));
        return;
      }

      for (const s of withWorktrees) {
        const branch = s.branch ?? "?";
        const status = s.status;
        console.log(`${s.id}  ${chalk.cyan(branch.padEnd(30))}  ${status.padEnd(10)}  ${s.summary ?? ""}`);
      }
    });

  worktree
    .command("cleanup")
    .description("Find and remove orphaned worktrees")
    .option("--dry-run", "Only show what would be removed")
    .action(async (opts) => {
      const orphans = await findOrphanedWorktrees(app);
      if (orphans.length === 0) {
        console.log(chalk.dim("No orphaned worktrees found"));
        return;
      }
      console.log(chalk.yellow(`Found ${orphans.length} orphaned worktrees:`));
      for (const id of orphans) console.log(`  ${id}`);
      if (opts.dryRun) return;
      const result = await cleanupWorktrees(app);
      console.log(chalk.green(`Removed: ${result.removed}`));
      if (result.errors.length) {
        console.log(chalk.red(`Errors: ${result.errors.length}`));
        for (const e of result.errors) console.log(chalk.dim(`  ${e}`));
      }
    });
}
