import type { DiffFile, DiffLine } from "../ui/DiffViewer.js";
import type { StageProgress } from "../ui/StageProgressBar.js";
import type { SessionStatus } from "../ui/StatusDot.js";

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
  const sessionAgent = session?.agent || "agent";

  // Dedup tracking: one event per stage transition, first checkpoint per stage
  const seenStageTransitions = new Set<string>();
  const seenCheckpointStages = new Set<string>();

  for (const ev of events || []) {
    all.push({ ...ev, _type: "event", _time: new Date(ev.created_at).getTime() });
  }
  for (const m of messages || []) {
    all.push({ ...m, _type: "message", _time: new Date(m.created_at).getTime() });
  }

  all.sort((a, b) => a._time - b._time);

  for (const item of all) {
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
      const nested = typeof item.data === "object" ? item.data?.data : null;
      const evDataObj = typeof item.data === "object" ? item.data : {};
      const evStage = item.stage || item.data?.stage || nested?.stage || undefined;

      if (HIDDEN_EVENT_TYPES.includes(evType)) continue;

      if (evType === "hook_status") {
        const hookData = typeof item.data === "object" ? item.data : {};
        const hookEvent = hookData.event || "";

        if (hookEvent === "PreToolUse") {
          const toolName = hookData.tool_name || "tool";
          const inputSummary = formatToolInput(hookData);
          const label = inputSummary ? `${toolName}: ${inputSummary}` : toolName;
          const idx = items.length;
          items.push({
            kind: "tool",
            label,
            timestamp: formatTime(item.created_at),
            status: "running" as const,
            stage: evStage,
          });
          pendingTools.set(toolName, idx);
        } else if (hookEvent === "PostToolUse") {
          const toolName = hookData.tool_name || "tool";
          const pendingIdx = pendingTools.get(toolName);
          if (pendingIdx !== undefined && items[pendingIdx]) {
            items[pendingIdx].status = "done";
            if (hookData.duration) {
              items[pendingIdx].duration = (hookData.duration / 1000).toFixed(1) + "s";
            }
            pendingTools.delete(toolName);
          } else {
            const inputSummary = formatToolInput(hookData);
            const label = inputSummary ? `${toolName}: ${inputSummary}` : toolName;
            items.push({
              kind: "tool",
              label,
              timestamp: formatTime(item.created_at),
              status: "done" as const,
              duration: hookData.duration ? (hookData.duration / 1000).toFixed(1) + "s" : undefined,
              stage: evStage,
            });
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
        // Only show the FIRST checkpoint per stage to avoid noise
        const cpKey = evStage || "__global__";
        if (seenCheckpointStages.has(cpKey)) continue;
        seenCheckpointStages.add(cpKey);

        const cpData = evDataObj;
        const status = cpData.status || "";
        const compute = cpData.compute || cpData.compute_type || "";
        const label = (evStage || "session") + (status ? " " + status : "");
        const suffix = compute ? " on " + compute + " compute" : "";
        items.push({
          kind: "system",
          content: label + suffix,
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
  }

  return items;
}
