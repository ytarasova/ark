import { type Command, Option } from "commander";
import chalk from "chalk";
import { execSync } from "child_process";
import * as core from "../../../core/index.js";
import { SESSION_STATUSES } from "../../../types/index.js";
import { getArkClient } from "../../app-client.js";

export function registerViewCommands(session: Command) {
  session
    .command("list")
    .description("List all sessions")
    .addOption(new Option("-s, --status <status>", "Filter by status").choices(SESSION_STATUSES as unknown as string[]))
    .option("-r, --repo <repo>", "Filter by repo")
    .option("-g, --group <group>", "Filter by group")
    .option("--archived", "Include archived sessions")
    .action(async (opts) => {
      const ark = await getArkClient();
      const filters: Record<string, unknown> = { ...opts, groupPrefix: core.profileGroupPrefix() || undefined };
      if (opts.archived) filters.status = "archived";
      delete filters.archived;
      const sessions = await ark.sessionList(
        filters as import("../../../types/index.js").SessionListParams & Record<string, unknown>,
      );
      if (!sessions.length) {
        console.log(chalk.dim("No sessions. Start one: ark session start --repo . --summary 'task'"));
        return;
      }
      const icons: Record<string, string> = {
        running: "●",
        waiting: "⏸",
        pending: "○",
        ready: "◎",
        completed: "✓",
        failed: "✕",
        blocked: "■",
        archived: "▪",
      };
      const colors: Record<string, (s: string) => string> = {
        running: chalk.blue,
        waiting: chalk.yellow,
        completed: chalk.green,
        failed: chalk.red,
        blocked: chalk.yellow,
        archived: chalk.dim,
      };
      for (const s of sessions) {
        const icon = icons[s.status] ?? "?";
        const color = colors[s.status] ?? chalk.dim;
        const group = s.group_name ? chalk.dim(`[${s.group_name}] `) : "";
        const summary = s.summary ?? s.ticket ?? s.repo ?? "-";
        console.log(`  ${color(icon)} ${s.id}  ${group}${summary.slice(0, 40)}  ${s.stage ?? "-"}  ${s.status}`);
      }
    });

  session
    .command("show")
    .description("Show session details")
    .argument("<id>", "Session ID")
    .action(async (id) => {
      const ark = await getArkClient();
      let s: any;
      try {
        const result = await ark.sessionRead(id);
        s = result.session;
      } catch (e: any) {
        console.log(chalk.red(e.message ?? `Session ${id} not found`));
        return;
      }
      if (!s) {
        console.log(chalk.red(`Session ${id} not found`));
        return;
      }
      console.log(chalk.bold(`\n${s.ticket ?? s.id}: ${s.summary ?? ""}`));
      console.log(`  ID:       ${s.id}`);
      console.log(`  Status:   ${s.status ?? "unknown"}`);
      console.log(`  Stage:    ${s.stage ?? "-"}`);
      console.log(`  Repo:     ${s.repo ?? "-"}`);
      console.log(`  Flow:     ${s.flow ?? "-"}`);
      console.log(`  Agent:    ${s.agent ?? "-"}`);
      if (s.branch) console.log(`  Branch:   ${s.branch}`);
      if (s.pr_url) console.log(`  PR:       ${s.pr_url}`);
      if (s.workdir) console.log(`  Workdir:  ${s.workdir}`);
      if (s.error) console.log(chalk.red(`  Error:    ${s.error}`));
      if (s.breakpoint_reason) console.log(chalk.yellow(`  Waiting:  ${s.breakpoint_reason}`));
    });

  session
    .command("attach")
    .description("Attach to a running agent session")
    .argument("<id>")
    .option("--print-only", "Print the attach command instead of running it")
    .action(async (id, opts) => {
      // Resolve the attach command via the RPC. The server returns
      // attachable:false for completed/failed/archived/not-yet-dispatched
      // sessions so we can surface a friendly message instead of trying to
      // spawn `tmux attach` against a pane that doesn't exist.
      const ark = await getArkClient();
      let res: { command: string; displayHint: string; attachable: boolean; reason?: string };
      try {
        res = await ark.sessionAttachCommand(id);
      } catch (e: any) {
        console.error(chalk.red(e?.message ?? `Session ${id} not found`));
        process.exit(1);
      }
      if (!res.attachable) {
        console.error(chalk.red(res.reason ?? "Session is not attachable."));
        console.error(chalk.dim("Try `ark session resume` if the agent needs to be relaunched."));
        process.exit(1);
      }
      if (opts.printOnly) {
        // Machine-friendly: stdout so it can be piped / captured.
        process.stdout.write(res.command + "\n");
        return;
      }
      execSync(res.command, { stdio: "inherit" });
    });

  session
    .command("output")
    .description("Show live output from a running session")
    .argument("<id>")
    .option("-n, --lines <n>", "Number of lines", "30")
    .action(async (id, opts) => {
      const ark = await getArkClient();
      const output = await ark.sessionOutput(id, Number(opts.lines));
      console.log(output || chalk.dim("No output"));
    });

  session
    .command("events")
    .description("Show event history")
    .argument("<id>")
    .action(async (id) => {
      const ark = await getArkClient();
      const { formatEvent } = await import("../../helpers.js");
      const events = await ark.sessionEvents(id);
      for (const e of events) {
        const ts = e.created_at.slice(11, 16);
        const msg = formatEvent(e.type, e.data ?? undefined);
        console.log(`  ${chalk.dim(ts)}  ${msg}`);
      }
    });
}
