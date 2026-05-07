/**
 * Report pipeline -- processes outbound channel reports from agents
 * (`completed`, `question`, `error`, `progress`) and produces a
 * `ReportResult` describing state transitions, messages, and events.
 */

import { execFileSync } from "child_process";

import type { OutboundMessage } from "../channel/channel-types.js";
import { logInfo } from "../../observability/structured-log.js";
import type { ReportResult, SessionHooksDeps } from "./types.js";
import { parseOnFailure } from "./types.js";

export class ReportApplier {
  constructor(private readonly deps: SessionHooksDeps) {}

  /**
   * Pure business logic for processing an agent channel report.
   * Determines state transitions, messages, and events without
   * touching the store, event bus, or session lifecycle directly.
   */
  async apply(sessionId: string, report: OutboundMessage): Promise<ReportResult> {
    const { sessions, getStage } = this.deps;
    const session = await sessions.get(sessionId);
    if (!session) {
      return { updates: {}, logEvents: [], busEvents: [] };
    }
    const result: ReportResult = { updates: {}, logEvents: [], busEvents: [] };

    // Log event
    result.logEvents!.push({
      type: `agent_${report.type}`,
      opts: {
        stage: report.stage,
        actor: "agent",
        data: report as unknown as Record<string, unknown>,
      },
    });

    // Build message content for chat view
    const r = report as unknown as Record<string, unknown>;
    const contentByType: Record<string, string | undefined> = {
      completed: (r.summary || r.message) as string | undefined,
      question: (r.question || r.message) as string | undefined,
      error: (r.error || r.message) as string | undefined,
      progress: (r.message || r.summary) as string | undefined,
    };
    let content = contentByType[report.type] || JSON.stringify(report);

    // Enrich with files, commits, PR URL when available
    const extras: string[] = [];
    if (r.pr_url) extras.push(`PR: ${r.pr_url}`);
    if (Array.isArray(r.filesChanged) && r.filesChanged.length > 0) {
      extras.push(`Files: ${(r.filesChanged as string[]).join(", ")}`);
    }
    if (Array.isArray(r.commits) && r.commits.length > 0) {
      extras.push(`Commits: ${(r.commits as string[]).join(", ")}`);
    }
    if (extras.length > 0) content += "\n" + extras.join("\n");
    result.message = { role: "agent", content, type: report.type };

    // Emit to event bus
    result.busEvents!.push({
      type: `agent_${report.type}`,
      sessionId,
      data: { stage: report.stage, data: report as unknown as Record<string, unknown> },
    });

    // Handle by type
    switch (report.type) {
      case "completed": {
        const rr = report as unknown as Record<string, unknown>;
        result.updates.config = {
          ...session.config,
          completion_summary: rr.summary as string | undefined,
          filesChanged: rr.filesChanged as string[] | undefined,
          commits: rr.commits as string[] | undefined,
        };

        if (rr.outcome) {
          result.outcome = rr.outcome as string;
        }

        // Hard enforcement: reject completion if no new commits exist for the current stage.
        if (session.workdir && session.branch) {
          try {
            const startSha = (session.config as any)?.stage_start_sha as string | undefined;
            let hasNewCommits = false;
            if (startSha) {
              const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
                cwd: session.workdir,
                encoding: "utf-8",
                timeout: 5000,
              }).trim();
              hasNewCommits = headSha !== startSha;
            } else {
              const newCommits = execFileSync("git", ["log", "--oneline", `origin/main..HEAD`], {
                cwd: session.workdir,
                encoding: "utf-8",
                timeout: 5000,
              }).trim();
              hasNewCommits = !!newCommits;
            }
            if (!hasNewCommits) {
              result.logEvents!.push({
                type: "completion_rejected",
                opts: {
                  stage: session.stage ?? undefined,
                  actor: "system",
                  data: { reason: "no new commits in worktree", stage_start_sha: startSha },
                },
              });
              result.message = {
                role: "system",
                content:
                  "Completion rejected: no new commits found for this stage. You must commit your changes, push, and create a PR before reporting completed.",
                type: "error",
              };
              break;
            }
          } catch {
            logInfo("session", "git check failed (e.g. no remote) -- continue to next check");
          }

          // Check for uncommitted changes
          try {
            const status = execFileSync("git", ["status", "--porcelain"], {
              cwd: session.workdir,
              encoding: "utf-8",
              timeout: 5000,
            }).trim();
            if (status) {
              const uncommitted = status.split("\n").filter((l) => {
                if (!l || l.startsWith("??")) return false;
                const file = l.slice(3).trim();
                if (file === ".mcp.json" || file.startsWith(".claude/")) return false;
                return true;
              });
              if (uncommitted.length > 0) {
                result.logEvents!.push({
                  type: "completion_rejected",
                  opts: {
                    stage: session.stage ?? undefined,
                    actor: "system",
                    data: { reason: "uncommitted changes in worktree", files: uncommitted.slice(0, 10) },
                  },
                });
                const fileList = uncommitted.slice(0, 5).join("\n");
                result.message = {
                  role: "system",
                  content: `Completion rejected: ${uncommitted.length} file(s) have uncommitted changes. Stage and commit all changes before reporting completed.\n${fileList}`,
                  type: "error",
                };
                break;
              }
            }
          } catch {
            logInfo("session", "git check failed -- allow completion to proceed");
          }
        }

        const stageDef = getStage(session.flow, session.stage ?? "");
        const isManualGate = stageDef?.gate === "manual";

        if (isManualGate) {
          result.logEvents!.push({
            type: "agent_completed",
            opts: {
              stage: session.stage ?? undefined,
              actor: "agent",
              data: { summary: (report as unknown as Record<string, unknown>).summary },
            },
          });
          // Flip status to `blocked` so the UI stops the running spinner and
          // surfaces Approve/Reject as the primary actions. Without this the
          // session sat at `running` forever after the agent's completion
          // hook fired -- manual-gate stages can't auto-advance.
          result.updates.status = "blocked";
          result.updates.session_id = null;
        } else {
          result.updates.status = "ready";
          result.updates.session_id = null;
          result.updates.error = null;
          result.shouldAdvance = true;
          result.shouldAutoDispatch = true;
        }
        break;
      }
      case "question": {
        const qr = report as unknown as Record<string, unknown>;
        result.updates.status = "waiting";
        result.updates.breakpoint_reason = (qr.question ?? qr.message) as string | null;
        break;
      }
      case "error": {
        const er = report as unknown as Record<string, unknown>;
        const errorMsg = String(er.error ?? er.message ?? "unknown error");
        result.updates.status = "failed";
        result.updates.error = errorMsg;

        const suggestions: string[] = [];
        if (errorMsg.includes("permission") || errorMsg.includes("denied")) {
          suggestions.push("Check file permissions and tool access settings");
        }
        if (errorMsg.includes("timeout") || errorMsg.includes("timed out")) {
          suggestions.push("Consider increasing the timeout or breaking the task into smaller steps");
        }
        if (errorMsg.includes("rate limit") || errorMsg.includes("429")) {
          suggestions.push("Wait a few minutes and retry, or switch to a different model provider");
        }
        if (suggestions.length === 0) {
          suggestions.push("Check terminal output for details", "Try restarting the session");
        }

        result.logEvents!.push({
          type: "session_failed",
          opts: {
            stage: session.stage ?? undefined,
            actor: "agent",
            data: {
              error: errorMsg,
              agent: session.agent,
              stage: session.stage,
              command: er.command ?? null,
              suggestions,
            },
          },
        });

        if (session.stage && session.flow) {
          const errStageDef = getStage(session.flow, session.stage);
          const retryDirective = parseOnFailure(errStageDef?.on_failure);
          if (retryDirective) {
            result.shouldRetry = true;
            result.retryMaxRetries = retryDirective.maxRetries;
          }
        }
        break;
      }
      case "progress": {
        if (session.status === "waiting") {
          result.updates.status = "running";
          result.updates.breakpoint_reason = null;
        }
        break;
      }
    }

    // PR URL from agent report
    const prUrl = (report as unknown as Record<string, unknown>).pr_url as string | undefined;
    if (prUrl && !session.pr_url) {
      result.prUrl = prUrl;
      result.updates.pr_url = prUrl;
    }

    return result;
  }
}
