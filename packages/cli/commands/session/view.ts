import { type Command, Option } from "commander";
import chalk from "chalk";
import { execSync } from "child_process";
import * as core from "../../../core/index.js";
import { SESSION_STATUSES } from "../../../types/index.js";
import type { AttachPlan } from "../../../core/services/session/attach.js";
import { getArkClient } from "../../app-client.js";
import { coloredStatusIcon } from "../../formatters.js";

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
      for (const s of sessions) {
        const group = s.group_name ? chalk.dim(`[${s.group_name}] `) : "";
        const summary = s.summary ?? s.ticket ?? s.repo ?? "-";
        console.log(
          `  ${coloredStatusIcon(s.status)} ${s.id}  ${group}${summary.slice(0, 40)}  ${s.stage ?? "-"}  ${s.status}`,
        );
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

      // Budget line: show usage and cap if either is present.
      const budgetCap = (s.config?.max_budget_usd as number | undefined) ?? null;
      const costUsed = (s.config?.cost_usd as number | undefined) ?? null;
      if (budgetCap !== null || costUsed !== null) {
        const usedStr = costUsed !== null ? `$${costUsed.toFixed(2)} used` : null;
        const capStr = budgetCap !== null ? `$${budgetCap.toFixed(2)} cap` : null;
        const pctStr =
          budgetCap !== null && costUsed !== null
            ? ` (${Math.min(100, Math.round((costUsed / budgetCap) * 100))}% used)`
            : "";
        const parts = [usedStr, capStr].filter(Boolean).join(" / ");
        console.log(`  Budget:   ${parts}${pctStr}`);
      }

      // for_each rollup block -- only shown when a checkpoint exists.
      const checkpoint = s.config?.for_each_checkpoint as
        | {
            stage_name?: string;
            total_items?: number;
            next_index?: number;
            in_flight?: { index?: number; child_session_id?: string; started_at?: string };
          }
        | null
        | undefined;
      if (checkpoint && typeof checkpoint === "object" && checkpoint.stage_name) {
        const totalItems = checkpoint.total_items ?? 0;

        // Fetch iteration-complete events to build rollup stats.
        let iterEvents: Array<{ data: Record<string, unknown> | null; created_at: string }> = [];
        try {
          const allEvents = await ark.sessionEvents(id);
          iterEvents = allEvents.filter((e: { type: string }) => e.type === "for_each_iteration_complete");
        } catch {
          // If events fetch fails, show what we have from checkpoint only.
        }

        const completedCount = iterEvents.length;
        const pct = totalItems > 0 ? Math.round((completedCount / totalItems) * 100) : 0;
        console.log(`  for_each: ${completedCount} of ${totalItems} iterations complete (${pct}%)`);

        if (iterEvents.length > 0) {
          // Sum cost and duration from enriched events.
          let totalCostUsd = 0;
          let totalDurationMs = 0;
          let durationCount = 0;
          for (const e of iterEvents) {
            const d = (e.data ?? {}) as Record<string, unknown>;
            if (typeof d.cost_usd === "number" && Number.isFinite(d.cost_usd)) {
              totalCostUsd += d.cost_usd as number;
            }
            if (typeof d.duration_ms === "number" && Number.isFinite(d.duration_ms)) {
              totalDurationMs += d.duration_ms as number;
              durationCount++;
            }
          }

          const avgMs = durationCount > 0 ? Math.round(totalDurationMs / durationCount) : null;
          const avgStr =
            avgMs !== null
              ? avgMs >= 60000
                ? `${Math.floor(avgMs / 60000)}m${Math.round((avgMs % 60000) / 1000)}s`
                : `${Math.round(avgMs / 1000)}s`
              : null;

          const costStr = `$${totalCostUsd.toFixed(2)} used`;
          const progressParts = [costStr, ...(avgStr !== null ? [`avg ${avgStr}/iteration`] : [])];
          console.log(`  Progress: ${progressParts.join(", ")}`);

          // Latest completed iteration.
          const latestEvt = iterEvents[iterEvents.length - 1];
          const latestData = (latestEvt?.data ?? {}) as Record<string, unknown>;
          const latestIdx = latestData.index;
          const latestDurMs = typeof latestData.duration_ms === "number" ? (latestData.duration_ms as number) : null;
          const latestCost =
            typeof latestData.cost_usd === "number" ? `$${(latestData.cost_usd as number).toFixed(2)}` : null;
          const latestDurStr =
            latestDurMs !== null
              ? latestDurMs >= 60000
                ? `${Math.floor(latestDurMs / 60000)}m${Math.round((latestDurMs % 60000) / 1000)}s`
                : `${Math.round(latestDurMs / 1000)}s`
              : null;
          const latestParts = [`iteration ${latestIdx}`, latestDurStr, latestCost, latestData.exit_status as string]
            .filter(Boolean)
            .join(", ");
          console.log(`  Latest:   ${latestParts}`);

          // Budget line for for_each if cap is set (supplement the budget line above).
          if (budgetCap !== null) {
            const budgetPct = Math.min(100, Math.round((totalCostUsd / budgetCap) * 100));
            console.log(`  Budget:   $${totalCostUsd.toFixed(2)} / $${budgetCap.toFixed(2)} (${budgetPct}%)`);
          }
        }

        // In-flight iteration.
        if (checkpoint.in_flight && typeof checkpoint.in_flight === "object") {
          const inf = checkpoint.in_flight;
          const infIdx = inf.index ?? "?";
          const childRef = inf.child_session_id ? ` (child ${inf.child_session_id})` : "";
          let agoStr = "";
          if (inf.started_at) {
            const startedMs = new Date(inf.started_at).getTime();
            if (!isNaN(startedMs)) {
              const elapsedMs = Date.now() - startedMs;
              const elapsedMin = Math.floor(elapsedMs / 60000);
              const elapsedSec = Math.round((elapsedMs % 60000) / 1000);
              agoStr = elapsedMin > 0 ? ` (${elapsedMin}m${elapsedSec}s ago)` : ` (${elapsedSec}s ago)`;
            }
          }
          console.log(`  In-flight: iteration ${infIdx}${agoStr}${childRef}`);
        }
      }
    });

  session
    .command("attach")
    .description("Attach to a running agent session")
    .argument("<id>")
    .option("--print-only", "Print the attach command instead of running it")
    .action(async (id, opts) => {
      const ark = await getArkClient();

      // Single RPC; the server owns the decision via SessionAttachService.
      // The response is a discriminated AttachPlan. Each mode has exactly
      // one CLI behaviour -- no spread of conditions across surfaces.
      let plan: AttachPlan;
      try {
        plan = (await ark.sessionAttachCommand(id)) as AttachPlan;
      } catch (e: any) {
        console.error(chalk.red(e?.message ?? `Session ${id} not found`));
        process.exit(1);
      }

      switch (plan.mode) {
        case "none":
          console.error(chalk.red(plan.reason));
          console.error(chalk.dim("Try `ark session resume` if the agent needs to be relaunched."));
          process.exit(1);
          return;

        case "tail": {
          if (opts.printOnly) {
            process.stdout.write(`tail -n 200 -F ${plan.transcriptPath} ${plan.stdioPath}\n`);
            return;
          }
          console.log(chalk.dim(`Attaching to ${id} (Ctrl-C to detach) -- ${plan.reason}`));
          console.log(chalk.dim(`Tailing: ${plan.transcriptPath}`));
          const proc = Bun.spawn({
            cmd: ["tail", "-n", "200", "-F", plan.transcriptPath, plan.stdioPath],
            stdout: "inherit",
            stderr: "inherit",
          });
          await proc.exited;
          return;
        }

        case "interactive":
          if (opts.printOnly) {
            // Machine-friendly: emit transport so it can be piped / captured.
            process.stdout.write(plan.transportCommand + "\n");
            return;
          }
          execSync(plan.transportCommand, { stdio: "inherit" });
          return;
      }
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
    .option("--iteration <n>", "Filter to events for a specific for_each iteration (by index)")
    .option("--summary", "Print one summary line per completed for_each iteration instead of individual events")
    .action(async (id, opts) => {
      const ark = await getArkClient();
      const { formatEvent } = await import("../../helpers.js");
      const events = await ark.sessionEvents(id);

      // --summary mode: print one line per completed for_each iteration.
      if (opts.summary) {
        const iterCompleteEvents = events.filter((e: { type: string }) => e.type === "for_each_iteration_complete");
        const totalEvts = events.filter(
          (e: { type: string }) => e.type === "for_each_start" || e.type === "for_each_complete",
        );
        // Try to get total_items from for_each_start or for_each_complete events.
        const startEvt = totalEvts.find((e: { type: string }) => e.type === "for_each_start");
        const total = (startEvt?.data as Record<string, unknown> | null | undefined)?.total ?? "?";

        if (iterCompleteEvents.length === 0) {
          console.log(chalk.dim("No completed for_each iterations found."));
          return;
        }

        for (const e of iterCompleteEvents) {
          const d = (e.data ?? {}) as Record<string, unknown>;
          const idx = d.index ?? "?";
          const exitStatus = (d.exit_status as string | undefined) ?? "completed";
          const statusIcon = exitStatus === "completed" ? chalk.green("PASS") : chalk.red("FAIL");
          const durationMs = typeof d.duration_ms === "number" ? (d.duration_ms as number) : null;
          const durStr =
            durationMs !== null
              ? durationMs >= 60000
                ? `${Math.floor(durationMs / 60000)}m${Math.round((durationMs % 60000) / 1000)}s`
                : `${Math.round(durationMs / 1000)}s`
              : null;
          const costUsd = typeof d.cost_usd === "number" ? `$${(d.cost_usd as number).toFixed(2)}` : null;
          const parts = [durStr, costUsd].filter(Boolean).join(", ");
          const detailStr = parts ? ` - ${parts}` : "";
          console.log(`  [${idx}/${total}] iteration ${idx}${detailStr} ${statusIcon}`);
        }
        return;
      }

      // --iteration <n> filter: show only events for that iteration index.
      if (opts.iteration !== undefined) {
        const iterN = Number(opts.iteration);
        const filtered = events.filter((e: { type: string; data: Record<string, unknown> | null }) => {
          const d = (e.data ?? {}) as Record<string, unknown>;
          return typeof d.index === "number" && d.index === iterN;
        });
        if (filtered.length === 0) {
          console.log(chalk.dim(`No events found for iteration ${iterN}.`));
          return;
        }
        for (const e of filtered) {
          const ts = e.created_at.slice(11, 16);
          const msg = formatEvent(e.type, e.data ?? undefined);
          console.log(`  ${chalk.dim(ts)}  ${msg}`);
        }
        return;
      }

      // Default: print all events.
      for (const e of events) {
        const ts = e.created_at.slice(11, 16);
        const msg = formatEvent(e.type, e.data ?? undefined);
        console.log(`  ${chalk.dim(ts)}  ${msg}`);
      }
    });
}
