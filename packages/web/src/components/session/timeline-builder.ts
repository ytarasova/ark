import type { DiffFile, DiffLine } from "../ui/DiffViewer.js";
import type { StageProgress } from "../ui/StageProgressBar.js";
import type { SessionStatus } from "../ui/StatusDot.js";
import { friendlyAgentName } from "../../lib/inline-display.js";

export function normalizeStatus(s: string): SessionStatus {
  const valid: SessionStatus[] = ["running", "waiting", "completed", "failed", "stopped", "pending"];
  if (valid.includes(s as SessionStatus)) return s as SessionStatus;
  if (s === "blocked" || s === "ready") return "pending";
  return "stopped";
}

export function buildStageProgress(session: any, flowStages: any[]): StageProgress[] {
  if (!flowStages || flowStages.length === 0) return [];
  const currentStage = session.stage;
  const currentIdx = flowStages.findIndex((s: any) => s.name === currentStage);
  const isFailed = session.status === "failed";
  const isStopped = session.status === "stopped";
  const isCompleted = session.status === "completed";
  const isRunning = session.status === "running" || session.status === "waiting";

  return flowStages.map((s: any, i: number) => {
    if (isCompleted) return { name: s.name, state: "done" as const };
    if (currentIdx < 0) return { name: s.name, state: "pending" as const };
    // Earlier stages genuinely advanced, mark them done regardless of
    // whether the session was later stopped / failed mid-flow.
    if (i < currentIdx) return { name: s.name, state: "done" as const };
    if (i === currentIdx) {
      if (isFailed) return { name: s.name, state: "failed" as const };
      if (isStopped) return { name: s.name, state: "stopped" as const };
      if (isRunning) return { name: s.name, state: "active" as const };
      return { name: s.name, state: "pending" as const };
    }
    return { name: s.name, state: "pending" as const };
  });
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Parse a unified diff string into DiffFile[] for the DiffViewer component. */
export function parseUnifiedDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  const fileChunks = raw.split(/^diff --git /m).filter(Boolean);

  for (const chunk of fileChunks) {
    const headerMatch = chunk.match(/^a\/(.+?)\s+b\/(.+)/m);
    const filename = headerMatch ? headerMatch[2] : "unknown";
    const lines: DiffLine[] = [];
    let additions = 0;
    let deletions = 0;
    let lineNumber = 0;

    const rawLines = chunk.split("\n");
    let inHunk = false;

    for (const line of rawLines) {
      const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
      if (hunkMatch) {
        lineNumber = parseInt(hunkMatch[1], 10);
        inHunk = true;
        lines.push({ type: "context", content: line });
        continue;
      }
      if (!inHunk) continue;

      if (line.startsWith("+")) {
        additions++;
        lines.push({ type: "add", lineNumber, content: line.slice(1) });
        lineNumber++;
      } else if (line.startsWith("-")) {
        deletions++;
        lines.push({ type: "remove", content: line.slice(1) });
      } else if (line.startsWith(" ")) {
        lines.push({ type: "context", lineNumber, content: line.slice(1) });
        lineNumber++;
      } else if (line.startsWith("\\")) {
        // "\ No newline at end of file" -- skip
      }
    }

    if (lines.length > 0) {
      files.push({ filename, additions, deletions, lines });
    }
  }

  return files;
}

/** Event types that should be hidden from the Conversation tab. */
const HIDDEN_EVENT_TYPES = ["session_stopped", "session_resumed"];

/** Truncate a string to maxLen, appending "..." if truncated. */
function truncate(s: string, maxLen = 120): string {
  return s.length > maxLen ? s.slice(0, maxLen) + "..." : s;
}

/** Format milliseconds as "350ms", "2.1s", "1m 3s". */
function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

/** Format tool input from hook data into a readable summary. */
function formatToolInput(data: any): string {
  if (!data) return "";
  const input = data.tool_input || data.input;
  if (!input) return "";
  if (typeof input === "string") {
    return input.length > 120 ? input.slice(0, 120) + "..." : input;
  }
  if (input.command) {
    const cmd = String(input.command);
    return cmd.length > 120 ? cmd.slice(0, 120) + "..." : cmd;
  }
  if (input.file_path || input.path) return input.file_path || input.path;
  if (input.pattern) return input.pattern;
  if (input.query) {
    const q = String(input.query);
    return q.length > 120 ? q.slice(0, 120) + "..." : q;
  }
  const json = JSON.stringify(input);
  return json.length > 120 ? json.slice(0, 120) + "..." : json;
}

/**
 * Map session events into conversation timeline items.
 *
 * Messages (from the messages table) are the authoritative source for agent
 * output. Events duplicate that content but lack role/type metadata. When
 * messages exist we skip the event-based agent items (agent_progress,
 * agent_completed, agent_question, agent_error) to avoid showing duplicates.
 */
export function buildConversationTimeline(events: any[], messages: any[], session?: any) {
  const items: any[] = [];
  const hasMessages = Array.isArray(messages) && messages.length > 0;
  const all: any[] = [];
  const pendingTools = new Map<string, number>();
  // Resolve a display name that doesn't leak the literal "inline" placeholder.
  // session.agent may be set to "inline" for inline-flow dispatches, which
  // bleeds into the typing indicator, agent message author labels, and
  // anywhere else this string is shown. friendlyAgentName falls back to the
  // active inline-flow stage's runtime (e.g. "agent-sdk"), then to a
  // generic "agent".
  const sessionAgent = friendlyAgentName(session) ?? "agent";

  // Dedup tracking: one event per stage transition.
  const seenStageTransitions = new Set<string>();

  for (const ev of events || []) {
    all.push({ ...ev, _type: "event", _time: new Date(ev.created_at).getTime() });
  }
  for (const m of messages || []) {
    all.push({ ...m, _type: "message", _time: new Date(m.created_at).getTime() });
  }

  all.sort((a, b) => a._time - b._time);

  for (const item of all) {
    const beforeCount = items.length;
    if (item._type === "message") {
      items.push({
        kind: item.role === "user" ? "user" : item.role === "system" ? "system" : "agent",
        role: item.role,
        content: item.content,
        timestamp: formatTime(item.created_at),
        agentName: item.role === "user" ? "You" : item.agent_name || sessionAgent || "assistant",
        model: item.model,
        type: item.type,
        stage: undefined,
      });
    } else {
      const evType = item.type || "";
      const evData = typeof item.data === "string" ? item.data : item.data?.message || "";
      // `typeof null === "object"` in JS -- guard against it explicitly,
      // otherwise any downstream `.message` / `.summary` read on evDataObj
      // will crash the render with "Cannot read properties of null".
      const nested = item.data && typeof item.data === "object" ? item.data?.data : null;
      const evDataObj = item.data && typeof item.data === "object" ? item.data : {};
      const evStage = item.stage || item.data?.stage || nested?.stage || undefined;

      if (HIDDEN_EVENT_TYPES.includes(evType)) continue;

      // agent-sdk narration / extended-thinking text. Renders as an inline
      // agent message between tool blocks so the user sees what the agent
      // is reasoning about, not just a stream of opaque tool calls.
      if (evType === "agent_message") {
        const data = item.data && typeof item.data === "object" ? item.data : {};
        const text = typeof data.text === "string" ? data.text : "";
        if (text.trim().length === 0) continue;
        items.push({
          kind: "agent",
          role: "assistant",
          content: text,
          timestamp: formatTime(item.created_at),
          agentName: sessionAgent || "agent",
          isThinking: !!data.thinking,
          stage: evStage,
        });
        continue;
      }

      if (evType === "hook_status") {
        const hookData = item.data && typeof item.data === "object" ? item.data : {};
        const hookEvent = hookData.event || "";

        if (hookEvent === "PreToolUse") {
          const toolName = hookData.tool_name || "tool";
          const toolInput = hookData.tool_input || hookData.input;
          const toolUseId = hookData.tool_use_id;
          const inputSummary = formatToolInput(hookData);
          const label = inputSummary ? `${toolName}: ${inputSummary}` : toolName;
          const idx = items.length;
          items.push({
            kind: "tool",
            toolName,
            toolInput,
            label,
            timestamp: formatTime(item.created_at),
            status: "running" as const,
            durationMs: undefined,
            stage: evStage,
          });
          // Prefer keying by tool_use_id -- a stable identifier that
          // survives parallel calls of the same tool and carries over
          // runtimes where PostToolUse doesn't echo tool_name (agent-sdk).
          // Fall back to name for runtimes that don't emit the id.
          pendingTools.set(toolUseId || toolName, idx);
        } else if (hookEvent === "PostToolUse") {
          const toolName = hookData.tool_name || "tool";
          // agent-sdk ships the result in `tool_result_content`; other
          // runtimes use tool_response / tool_output / output. Read all.
          const toolOutput =
            hookData.tool_response ?? hookData.tool_output ?? hookData.output ?? hookData.tool_result_content;
          const toolUseId = hookData.tool_use_id;
          const pendingKey = toolUseId && pendingTools.has(toolUseId) ? toolUseId : toolName;
          const pendingIdx = pendingTools.get(pendingKey);
          if (pendingIdx !== undefined && items[pendingIdx]) {
            items[pendingIdx].status = hookData.is_error ? "error" : "done";
            items[pendingIdx].toolOutput = toolOutput;
            if (hookData.duration) {
              items[pendingIdx].duration = (hookData.duration / 1000).toFixed(1) + "s";
              items[pendingIdx].durationMs = hookData.duration;
            }
            pendingTools.delete(pendingKey);
          } else {
            // Orphan PostToolUse (no matching PreToolUse tracked). Skip it
            // rather than synthesizing an empty `tool {}` row -- the row
            // would have no name, no input, and misleading output framing.
            continue;
          }
        } else if (hookEvent === "SessionStart" || hookEvent === "UserPromptSubmit") {
          // Infrastructure events -- skip
        } else if (hookData.agent_status === "busy") {
          const agentName = hookData.agent || evStage || sessionAgent;
          const toolName = hookData.tool_name || "";
          let activity = "working";
          if (toolName === "Read" || toolName === "read_file") activity = "reading files";
          else if (toolName === "Bash" || toolName === "bash") activity = "running commands";
          else if (toolName === "Edit" || toolName === "write_file") activity = "editing files";
          else if (toolName === "Grep" || toolName === "search") activity = "searching";
          else if (toolName) activity = "using " + toolName;
          items.push({
            kind: "system",
            content: agentName + " is " + activity + "...",
            timestamp: formatTime(item.created_at),
            stage: evStage,
          });
        }
        continue;
      }

      if (evType === "checkpoint") {
        const cpData = evDataObj;
        const status = String(cpData.status || "");
        // Skip a `ready` checkpoint when a stage_ready for the same stage
        // already rendered -- they describe the same transition from
        // different layers (orchestrator vs. checkpoint writer).
        if (status === "ready" && seenStageTransitions.has("ready:" + (evStage || "unknown"))) continue;

        const compute = cpData.compute || cpData.compute_type || "";
        const worktree = cpData.worktree || "";
        const stageLabel = evStage || "session";
        // Human label: "Checkpoint: <stage> <status>" rather than the
        // ambiguous raw form ("per_repo ready") that reads like a stage.
        const head = `Checkpoint: ${stageLabel}${status ? " " + status : ""}`;
        const extras: string[] = [];
        if (compute) extras.push(`compute: ${compute}`);
        if (worktree) extras.push(`worktree: ${truncate(String(worktree), 60)}`);
        const suffix = extras.length > 0 ? ` (${extras.join(", ")})` : "";
        items.push({
          kind: "system",
          content: head + suffix,
          timestamp: formatTime(item.created_at),
          stage: evStage,
        });
        continue;
      }

      const isAgentChannelEvent =
        evType === "agent_progress" ||
        evType === "agent_completed" ||
        evType === "agent_question" ||
        evType === "agent_error";
      if (hasMessages && isAgentChannelEvent) {
        continue;
      }

      if (evType === "agent_progress") {
        const msg = nested?.message || evData;
        if (msg) {
          items.push({
            kind: "agent",
            content: msg,
            timestamp: formatTime(item.created_at),
            agentName: evStage || sessionAgent,
            model: nested?.model,
            type: "progress",
            stage: evStage,
          });
        }
      } else if (evType === "agent_completed") {
        const summary = nested?.summary || nested?.message || evData;
        const extras: string[] = [];
        if (nested?.pr_url) extras.push("PR: " + nested.pr_url);
        if (Array.isArray(nested?.filesChanged) && nested.filesChanged.length > 0)
          extras.push("Files: " + nested.filesChanged.join(", "));
        const content = extras.length > 0 ? summary + "\n" + extras.join("\n") : summary;
        items.push({
          kind: "agent",
          content: content || "Stage completed",
          timestamp: formatTime(item.created_at),
          agentName: evStage || sessionAgent,
          model: nested?.model,
          type: "completed",
          stage: evStage,
        });
      } else if (evType === "agent_question") {
        items.push({
          kind: "agent",
          content: nested?.question || evData || "Agent has a question",
          timestamp: formatTime(item.created_at),
          agentName: evStage || sessionAgent,
          model: undefined,
          type: "question",
          stage: evStage,
        });
      } else if (evType === "agent_error") {
        items.push({
          kind: "system",
          content: "Error: " + (nested?.error || evData || "Unknown error"),
          timestamp: formatTime(item.created_at),
          stage: evStage,
        });
      } else if (evType === "stage_ready") {
        // Deduplicate: if we already showed a stage_handoff for this stage, skip stage_ready
        const readyKey = "ready:" + (evStage || "unknown");
        const handoffKey = "handoff:" + (evStage || "unknown");
        if (seenStageTransitions.has(handoffKey) || seenStageTransitions.has(readyKey)) continue;
        seenStageTransitions.add(readyKey);

        const stageData = evDataObj;
        const agent = stageData.agent || stageData.stage_agent || "";
        const gate = stageData.gate || "";
        const parts = [agent && "agent: " + agent, gate && "gate: " + gate].filter(Boolean);
        const detail = parts.length > 0 ? " (" + parts.join(", ") + ")" : "";
        items.push({
          kind: "system",
          content: "Stage " + (evStage || "unknown") + " ready" + detail,
          timestamp: formatTime(item.created_at),
          stage: evStage,
        });
      } else if (evType === "stage_started") {
        const stageData = evDataObj;
        const agent = stageData.agent || "";
        const model = stageData.model || "";
        const taskPreview: string = stageData.task || stageData.summary || "";
        const preview = taskPreview.length > 80 ? taskPreview.slice(0, 80) + "..." : taskPreview;
        const agentLabel = agent || evStage || "agent";
        const modelSuffix = model ? " (" + model + ")" : "";
        const previewSuffix = preview ? " -- " + preview : "";
        items.push({
          kind: "system",
          content: agentLabel + " started" + modelSuffix + previewSuffix,
          timestamp: formatTime(item.created_at),
          stage: evStage,
        });
      } else if (evType === "stage_completed") {
        const stageData = evDataObj;
        const agent = stageData.agent || "";
        const note = stageData.note || stageData.summary || stageData.message || "";
        const agentSuffix = agent ? " (" + agent + ")" : "";
        const noteSuffix = note ? " -- " + truncate(note, 100) : "";
        items.push({
          kind: "system",
          content: "Stage " + (evStage || "unknown") + " completed" + agentSuffix + noteSuffix,
          timestamp: formatTime(item.created_at),
          stage: evStage,
        });
      } else if (evType === "stage_handoff") {
        const handoffData = evDataObj;
        const toStage = handoffData.to_stage || evStage || nested?.stage || "";
        const fromStage = handoffData.from_stage || "";

        // Self-loop: stage advancing to itself isn't a user-facing transition
        // (usually the orchestrator rescheduling the same stage after a
        // fan-out / resume). Drop it rather than print "Advancing to X (from X)".
        if (fromStage && toStage && fromStage === toStage) continue;

        // Deduplicate: only one handoff event per target stage
        const handoffKey = "handoff:" + (toStage || "unknown");
        if (seenStageTransitions.has(handoffKey)) continue;
        seenStageTransitions.add(handoffKey);
        // Also mark ready as seen so stage_ready for the same stage is suppressed
        seenStageTransitions.add("ready:" + (toStage || "unknown"));

        const fromSuffix = fromStage ? " (from " + fromStage + ")" : "";
        items.push({
          kind: "system",
          content: toStage ? "Advancing to " + toStage + fromSuffix : "Advancing to next stage",
          timestamp: formatTime(item.created_at),
          stage: evStage,
        });
      } else if (evType === "for_each_start") {
        const total = evDataObj.total;
        const iterVar = evDataObj.iterVar;
        const count = typeof total === "number" ? total : 0;
        const noun = iterVar ? `${iterVar}${count === 1 ? "" : "s"}` : `item${count === 1 ? "" : "s"}`;
        items.push({
          kind: "system",
          content: count > 0 ? `Fanning out over ${count} ${noun}` : "Fanning out",
          timestamp: formatTime(item.created_at),
          stage: evStage,
        });
      } else if (evType === "for_each_iteration_start") {
        const index = evDataObj.index;
        const idxLabel = typeof index === "number" ? `${index + 1}` : "?";
        items.push({
          kind: "system",
          content: `Iteration ${idxLabel} started`,
          timestamp: formatTime(item.created_at),
          stage: evStage,
        });
      } else if (evType === "for_each_iteration_complete") {
        const index = evDataObj.index;
        const idxLabel = typeof index === "number" ? `${index + 1}` : "?";
        const cost = typeof evDataObj.cost_usd === "number" ? evDataObj.cost_usd : null;
        const durMs = typeof evDataObj.duration_ms === "number" ? evDataObj.duration_ms : null;
        const extras: string[] = [];
        if (durMs != null) extras.push(formatDurationMs(durMs));
        if (cost != null && cost > 0) extras.push(`$${cost.toFixed(2)}`);
        const suffix = extras.length > 0 ? ` (${extras.join(", ")})` : "";
        items.push({
          kind: "system",
          content: `Iteration ${idxLabel} complete${suffix}`,
          timestamp: formatTime(item.created_at),
          stage: evStage,
        });
      } else if (evType === "for_each_iteration_failed") {
        const index = evDataObj.index;
        const idxLabel = typeof index === "number" ? `${index + 1}` : "?";
        const reason = evDataObj.reason || evDataObj.error || "";
        items.push({
          kind: "system",
          content: reason
            ? `Iteration ${idxLabel} failed -- ${truncate(String(reason), 100)}`
            : `Iteration ${idxLabel} failed`,
          timestamp: formatTime(item.created_at),
          stage: evStage,
        });
      } else if (evType === "for_each_complete") {
        const total = evDataObj.total;
        const succeeded = evDataObj.succeeded;
        const failed = evDataObj.failed;
        const parts: string[] = [];
        if (typeof succeeded === "number") parts.push(`${succeeded} succeeded`);
        if (typeof failed === "number" && failed > 0) parts.push(`${failed} failed`);
        const totalStr = typeof total === "number" ? `${total} iteration${total === 1 ? "" : "s"}` : "iterations";
        const summary = parts.length > 0 ? ` (${parts.join(", ")})` : "";
        items.push({
          kind: "system",
          content: `Fan-out complete -- ${totalStr}${summary}`,
          timestamp: formatTime(item.created_at),
          stage: evStage,
        });
      } else if (evType === "pr_detected") {
        const prUrl = evDataObj.pr_url || nested?.pr_url || "";
        const label = prUrl ? "PR detected: " + prUrl : "PR detected";
        items.push({
          kind: "system",
          content: label,
          timestamp: formatTime(item.created_at),
          stage: evStage,
        });
      } else if (evType === "action_executed") {
        const action = evDataObj.action || nested?.action || "";
        const prUrl = evDataObj.pr_url || nested?.pr_url || "";
        const skipped = evDataObj.skipped || nested?.skipped || "";
        const parts: string[] = [];
        if (action === "create_pr" || action === "auto_create_pr") {
          parts.push(prUrl ? "PR created: " + prUrl : "PR created");
        } else if (action === "merge_pr" || action === "merge" || action === "auto_merge") {
          parts.push(prUrl ? "PR merged: " + prUrl : "PR merged");
        } else if (action === "close") {
          parts.push("Session closed");
        } else {
          parts.push("Action: " + (action || "unknown"));
        }
        if (skipped) parts.push("(" + skipped.replace(/_/g, " ") + ")");
        items.push({
          kind: "system",
          content: parts.join(" "),
          timestamp: formatTime(item.created_at),
          stage: evStage,
        });
      } else if (evType === "session_completed") {
        const finalStage = evDataObj.final_stage || evStage || "";
        const flow = evDataObj.flow || "";
        const summaryParts: string[] = ["Session completed"];
        if (finalStage) summaryParts.push("at stage " + finalStage);
        if (flow) summaryParts.push("(flow: " + flow + ")");
        items.push({
          kind: "system",
          content: summaryParts.join(" "),
          timestamp: formatTime(item.created_at),
          stage: evStage,
        });
      } else if (evType.includes("dispatch") || evType.includes("advance")) {
        items.push({
          kind: "system",
          content: evData || evType.replace(/_/g, " "),
          timestamp: formatTime(item.created_at),
          stage: evStage,
        });
      } else if (evType.includes("tool")) {
        const isError = evType.includes("error") || evType.includes("fail");
        items.push({
          kind: "tool",
          label: evData || evType.replace(/_/g, " "),
          timestamp: formatTime(item.created_at),
          status: isError ? "error" : "done",
          duration: item.data?.duration ? (item.data.duration / 1000).toFixed(1) + "s" : undefined,
          error: isError ? item.data?.error || evData : undefined,
          stage: evStage,
        });
      } else if (
        evType.includes("completion_rejected") ||
        evType.includes("guardrail") ||
        evType.includes("retry") ||
        evType.includes("verification")
      ) {
        items.push({
          kind: "system",
          content: evData || evType.replace(/_/g, " "),
          timestamp: formatTime(item.created_at),
          stage: evStage,
        });
      } else {
        // Show all other events with context from their data field
        const msg =
          evDataObj.message ||
          evDataObj.reason ||
          evDataObj.summary ||
          evDataObj.pr_url ||
          (typeof item.data === "string" ? item.data : "");
        const label = msg ? evType.replace(/_/g, " ") + " -- " + truncate(String(msg), 120) : evType.replace(/_/g, " ");
        if (label) {
          items.push({ kind: "system", content: label, timestamp: formatTime(item.created_at), stage: evStage });
        }
      }
    }
    // Attach the originating event to every item pushed this iteration so
    // the Timeline view can open the raw record in a drawer. We skip
    // message-sourced items -- their text is already visible in the bubble
    // and the drawer renderer is shaped for events. We also don't overwrite
    // rawEvent on existing rows (pendingTools merges PostToolUse into the
    // PreToolUse row, and keeping PreToolUse preserves the "when the tool
    // started" framing).
    if (item._type === "event") {
      for (let i = beforeCount; i < items.length; i++) {
        if (items[i].rawEvent === undefined) items[i].rawEvent = item;
      }
    }
  }

  // If the session has reached a terminal state, any tool block still
  // tracked in pendingTools never received a PostToolUse -- the runtime
  // was killed (timeout / stop / crash) mid-call. Flip them to
  // `interrupted` so the UI doesn't render a forever-spinning "RUNNING"
  // badge with a stop affordance on a session that's already done.
  // Real incident: PAI-31995 dispatch hit a 30-min for_each timeout while
  // a Bash gradle find was still in flight; the parent went `completed`
  // but the orphan tool block stayed `running` indefinitely.
  const sessionStatus = session?.status as string | undefined;
  const sessionTerminal =
    sessionStatus === "completed" ||
    sessionStatus === "failed" ||
    sessionStatus === "stopped" ||
    sessionStatus === "archived";
  if (sessionTerminal && pendingTools.size > 0) {
    for (const idx of pendingTools.values()) {
      if (items[idx] && items[idx].status === "running") {
        items[idx].status = "interrupted";
      }
    }
    pendingTools.clear();
  }

  return items;
}
