/**
 * Task/prompt construction -- format task headers, build handoff context, extract subtasks.
 *
 * Extracted from session-orchestration.ts. All functions take app: AppContext as first arg.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { promisify } from "util";
import { execFile } from "child_process";

const execFileAsync = promisify(execFile);

import type { AppContext } from "../app.js";
import type { Session } from "../../types/index.js";
import * as agentRegistry from "../agent/agent.js";
import { buildSessionVars } from "../template.js";
import { resolveFlow } from "../state/flow.js";
import { filterMessages, parseMessageFilter } from "../message-filter.js";
import { logDebug, logWarn } from "../observability/structured-log.js";
import { buildStreamSubtasks, type SageAnalysis } from "../integrations/sage-analysis.js";

/** Convert a typed Session to a plain Record for template variable resolution. */
export function sessionAsVars(session: Session): Record<string, unknown> {
  const rec: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(session)) rec[k] = v;
  return rec;
}

/** Build the task header: agent role, stage description, and reporting instructions. */
export function formatTaskHeader(app: AppContext, session: Session, stage: string, agentName: string): string[] {
  const parts: string[] = [];
  const isBare = session.flow === "bare";

  // Get resolved stage with substituted variables
  const vars = buildSessionVars(sessionAsVars(session));
  const resolved = resolveFlow(app, session.flow, vars);
  const stageDef = resolved?.stages.find((s) => s.name === stage);

  // Every autonomously-dispatched session (including bare) gets an actionable
  // first-turn prompt. The system prompt gives Claude context, but Claude only
  // starts working when it receives a user message -- this IS that user message.
  // "Wait for instructions via steer" framing is wrong for --dispatch mode.
  if (stageDef?.task) {
    parts.push(stageDef.task);
    parts.push(`\nYou are the ${agentName} agent, running the '${stage}' stage.`);
  } else if (isBare) {
    // Bare flow under autonomous dispatch: treat the summary as an actionable task.
    parts.push(`Begin working on the following task immediately. Do not ask for confirmation.`);
    parts.push(`\nTask: ${session.summary ?? "(no summary provided)"}`);
    parts.push(`\nYou are the ${agentName} agent.`);
  } else {
    parts.push(`Work on ${session.ticket ?? session.id}: ${session.summary ?? "the task"}`);
    parts.push(`\nYou are the ${agentName} agent, running the '${stage}' stage.`);
  }

  // Readiness + completion reporting
  parts.push(
    `\nWhen you start up, immediately call the \`report\` tool with type='progress' to announce you are online and ready for work.`,
  );
  parts.push(
    `When you finish your work, call \`report\` with type='completed' and a concise summary of what you accomplished (files changed, tests added, key decisions). This summary is shown to the user in the dashboard.`,
  );

  // Append file attachments if present
  const attachments = (session.config as any)?.attachments as
    | Array<{ name: string; content: string; type: string }>
    | undefined;
  if (attachments?.length) {
    parts.push("\n## Attached Files\n");
    parts.push("Files are saved to `.ark/attachments/` in the working directory.\n");
    for (const att of attachments) {
      if (att.content?.startsWith("data:")) {
        parts.push(`### ${att.name}\nBinary file (${att.type}) at \`.ark/attachments/${att.name}\`\n`);
      } else {
        parts.push(`### ${att.name}\n\`\`\`\n${att.content}\n\`\`\`\n`);
      }
    }
  }

  return parts;
}

/** Append previous stage context: completed stages, PLAN.md, and recent git log. */
export async function appendPreviousStageContext(app: AppContext, session: Session): Promise<string[]> {
  const parts: string[] = [];

  // Previous stage context
  const events = await app.events.list(session.id);
  const completed = events.filter((e) => e.type === "stage_completed");
  if (completed.length) {
    parts.push("\n## Previous stages:");
    for (const c of completed) {
      const d = c.data ?? {};
      parts.push(`- ${c.stage} (agent=${d.agent ?? "?"}, turns=${d.num_turns ?? "?"}, cost=$${d.cost_usd ?? 0})`);
    }
  }

  // Check for PLAN.md
  const wtDir = join(app.config.worktreesDir, session.id);
  const planPath = join(wtDir, "PLAN.md");
  if (existsSync(planPath)) {
    let plan = readFileSync(planPath, "utf-8");
    if (plan.length > 3000) plan = plan.slice(0, 3000) + "\n... (truncated)";
    parts.push(`\n## PLAN.md:\n${plan}`);
  } else {
    // Fallback: inject completion summary from previous stage as plan context.
    // Covers cases where the planner reported its analysis in the completion
    // summary but failed to write PLAN.md.
    const completionSummary = (session.config as any)?.completion_summary as string | undefined;
    if (completionSummary) {
      parts.push(`\n## Previous stage summary (PLAN.md not found):\n${completionSummary.slice(0, 3000)}`);
    }
  }

  // Git log
  if (existsSync(wtDir)) {
    try {
      const { stdout: log } = await execFileAsync("git", ["-C", wtDir, "log", "--oneline", "-10", "--no-decorate"], {
        encoding: "utf-8",
      });
      if (log.trim()) parts.push(`\n## Recent commits:\n${log.trim()}`);
    } catch {
      logDebug("session", "Expected: worktree dir may not be a git repo yet");
    }
  }

  return parts;
}

export async function buildTaskWithHandoff(
  app: AppContext,
  session: Session,
  stage: string,
  agentName: string,
): Promise<string> {
  const header = formatTaskHeader(app, session, stage, agentName);
  const context = await appendPreviousStageContext(app, session);

  // Apply message filter if agent config specifies one
  try {
    const projectRoot = agentRegistry.findProjectRoot(session.workdir || session.repo) ?? undefined;
    const agent = app.agents.get(agentName, projectRoot);
    if (agent) {
      const mFilter = parseMessageFilter(agent);
      if (mFilter) {
        const messages = (await app.messages.list(session.id)).map((m) => ({
          role: m.role,
          content: m.content,
          timestamp: m.created_at,
        }));
        const filtered = filterMessages(messages, mFilter);
        if (filtered.length > 0) {
          context.push("\n## Filtered conversation context:");
          for (const m of filtered) {
            context.push(`[${m.role}]: ${m.content.slice(0, 500)}`);
          }
        }
      }
    }
  } catch {
    logDebug("session", "skip message filtering on error");
  }

  return [...header, ...context].join("\n");
}

export function extractSubtasks(app: AppContext, session: Session): { name: string; task: string }[] {
  // Sage-analysis path: when the session was seeded with a pi-sage analysis
  // JSON (via --input analysis_json=<path> or the `fetch_sage_analysis`
  // action), fan out one subtask per plan_stream. This is the happy path for
  // the `from-sage-analysis` flow.
  const inputs = (session.config as any)?.inputs as { files?: Record<string, string> } | undefined;
  const analysisPath = inputs?.files?.analysis_json;
  if (analysisPath && existsSync(analysisPath)) {
    try {
      const analysis = JSON.parse(readFileSync(analysisPath, "utf-8")) as SageAnalysis;
      if (Array.isArray(analysis.plan_streams) && analysis.plan_streams.length > 0) {
        return buildStreamSubtasks(analysis).map((s) => ({ name: s.name, task: s.task }));
      }
    } catch (e: any) {
      logWarn("session", `extractSubtasks: failed to load analysis from ${analysisPath}: ${e?.message ?? e}`);
    }
  }

  const wtDir = join(app.config.worktreesDir, session.id);
  const planPath = join(wtDir, "PLAN.md");

  if (existsSync(planPath)) {
    const plan = readFileSync(planPath, "utf-8");
    const steps = [...plan.matchAll(/^##\s+(?:Step\s+)?(\d+)[.:]\s*(.+)/gm)];
    if (steps.length >= 2) {
      return steps.map(([, num, title]) => ({
        name: `step-${num}`,
        task: `Step ${num}: ${title.trim()}. Follow PLAN.md.`,
      }));
    }
  }

  const summary = session.summary ?? "the task";
  return [
    { name: "implementation", task: `Implement: ${summary}` },
    { name: "tests", task: `Write tests for: ${summary}` },
  ];
}
