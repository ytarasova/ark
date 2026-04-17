import type { TimelineEvent, EventColor } from "../ui/EventTimeline.js";
import { formatTime } from "./timeline-builder.js";

/** Render agent message content with structured formatting for completion messages. */
export function renderAgentContent(content: string, type?: string): React.ReactNode {
  if (!content) return <p>--</p>;
  if (type === "completed") {
    const lines = content.split("\n");
    const parts: React.ReactNode[] = [];
    let summaryLines: string[] = [];

    for (const line of lines) {
      const prMatch = line.match(/^PR:\s*(https?:\/\/\S+)/);
      const filesMatch = line.match(/^Files:\s*(.+)/);
      const commitsMatch = line.match(/^Commits?:\s*(.+)/);

      if (prMatch) {
        if (summaryLines.length > 0) {
          parts.push(<p key={"s" + parts.length}>{summaryLines.join(" ")}</p>);
          summaryLines = [];
        }
        parts.push(
          <p key={"pr" + parts.length}>
            <a
              href={prMatch[1]}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--primary)] underline hover:text-[var(--primary-hover)]"
              aria-label="View pull request on GitHub"
            >
              View PR on GitHub
            </a>
          </p>,
        );
      } else if (filesMatch) {
        if (summaryLines.length > 0) {
          parts.push(<p key={"s" + parts.length}>{summaryLines.join(" ")}</p>);
          summaryLines = [];
        }
        const files = filesMatch[1].split(",").map((f) => f.trim());
        parts.push(
          <ul key={"f" + parts.length} className="list-none pl-0 my-1">
            {files.map((f, fi) => (
              <li key={fi} className="text-[12px] font-[family-name:var(--font-mono)] text-[var(--fg-muted)]">
                <span className="mr-1.5 opacity-60">{"\u{1F4C4}"}</span>
                {f}
              </li>
            ))}
          </ul>,
        );
      } else if (commitsMatch) {
        if (summaryLines.length > 0) {
          parts.push(<p key={"s" + parts.length}>{summaryLines.join(" ")}</p>);
          summaryLines = [];
        }
        const commits = commitsMatch[1].split(",").map((c) => c.trim());
        parts.push(
          <p key={"c" + parts.length} className="text-[12px] my-1">
            {commits.map((c, ci) => (
              <span key={ci}>
                {ci > 0 && ", "}
                <code className="font-[family-name:var(--font-mono)] bg-[var(--bg-code)] px-1 py-0.5 rounded text-[11px]">
                  {c}
                </code>
              </span>
            ))}
          </p>,
        );
      } else {
        summaryLines.push(line);
      }
    }
    if (summaryLines.length > 0) {
      parts.push(<p key={"s" + parts.length}>{summaryLines.join(" ")}</p>);
    }
    if (parts.length > 0) return <>{parts}</>;
  }
  return <p>{content}</p>;
}

/** Build a rich TimelineEvent for the Events tab with contextual labels and colors. */
export function buildRichTimelineEvent(ev: any, i: number): TimelineEvent {
  const id = String(ev.id || i);
  const timestamp = formatTime(ev.created_at);
  const evType: string = ev.type || "";
  const data = typeof ev.data === "object" && ev.data !== null ? ev.data : {};
  const stageName: string = ev.stage || data.stage || "";

  let color: EventColor = "gray";
  if (evType.includes("completed") || evType.includes("done")) color = "green";
  else if (evType.includes("started") || evType.includes("ready") || evType.includes("resumed")) color = "blue";
  else if (evType.includes("error") || evType.includes("fail")) color = "red";
  else if (evType.includes("stopped") || evType.includes("checkpoint")) color = "amber";

  let label: React.ReactNode;
  let detail: string | undefined;
  const rawData: Record<string, unknown> | undefined = Object.keys(data).length > 0 ? data : undefined;

  if (evType === "stage_ready") {
    const agent = data.agent || "";
    const gate = data.gate || "";
    const parts = [agent && "agent: " + agent, gate && "gate: " + gate].filter(Boolean);
    label = (
      <span>
        Stage <strong>{stageName}</strong> ready
        {parts.length > 0 && <span className="text-[var(--fg-muted)]"> ({parts.join(", ")})</span>}
      </span>
    );
  } else if (evType === "stage_started") {
    const agent = data.agent || "";
    const model = data.model || "";
    const tools: string[] = Array.isArray(data.tools) ? data.tools : [];
    const taskPreview: string = data.task_preview || "";
    const previewText = taskPreview.length > 80 ? taskPreview.slice(0, 80) + "..." : taskPreview;
    label = (
      <span>
        <strong>{agent || stageName || "agent"}</strong> started
        {model && <span className="text-[var(--fg-muted)]"> ({model})</span>}
        {previewText && <span className="text-[var(--fg-muted)]">{" -- " + previewText}</span>}
      </span>
    );
    if (tools.length > 0) {
      detail = "Tools: " + tools.join(", ");
      if (taskPreview.length > 80) detail += "\nTask: " + taskPreview;
    }
  } else if (evType === "stage_completed") {
    const agent = data.agent || "";
    label = (
      <span>
        Stage <strong>{stageName}</strong> completed
        {agent && <span className="text-[var(--fg-muted)]"> ({agent})</span>}
      </span>
    );
    color = "green";
  } else if (evType === "checkpoint") {
    const status = data.status || "";
    const compute = data.compute || data.compute_type || "";
    const worktree = data.worktree || "";
    label = (
      <span>
        Checkpoint: <strong>{stageName || "session"}</strong>
        {status && (
          <>
            {" "}
            <strong>{status}</strong>
          </>
        )}
        {compute && <span className="text-[var(--fg-muted)]"> on {compute}</span>}
      </span>
    );
    if (worktree) detail = "Worktree: " + worktree;
  } else if (evType === "session_completed") {
    const reason = data.reason || data.message || "";
    label = <span>Session completed{reason && <span className="text-[var(--fg-muted)]">: {reason}</span>}</span>;
    color = "green";
  } else if (evType === "session_stopped") {
    const actor = data.actor || ev.actor || "";
    label = <span>Session stopped{actor && <span className="text-[var(--fg-muted)]"> by {actor}</span>}</span>;
    color = "red";
  } else if (evType === "session_resumed") {
    const actor = data.actor || ev.actor || "";
    label = <span>Session resumed{actor && <span className="text-[var(--fg-muted)]"> by {actor}</span>}</span>;
    color = "blue";
  } else if (evType === "session_started") {
    const flow = data.flow || "";
    const agent = data.agent || "";
    const parts = [flow && "flow: " + flow, agent && "agent: " + agent].filter(Boolean);
    label = (
      <span>
        Session started
        {parts.length > 0 && <span className="text-[var(--fg-muted)]"> ({parts.join(", ")})</span>}
      </span>
    );
    color = "blue";
  } else if (evType.includes("error") || evType.includes("fail")) {
    const msg = data.error || data.message || (typeof ev.data === "string" ? ev.data : "");
    label = (
      <span>
        <strong className="text-[var(--failed)]">{evType.replace(/_/g, " ")}</strong>
        {msg && <span className="text-[var(--fg-muted)]">: {msg}</span>}
      </span>
    );
    color = "red";
  } else if (evType === "dispatch" || evType === "advance") {
    label = (
      <span>
        {evType.charAt(0).toUpperCase() + evType.slice(1)}
        {stageName && (
          <span className="text-[var(--fg-muted)]">
            {" -- stage: "}
            <strong>{stageName}</strong>
          </span>
        )}
      </span>
    );
    color = "blue";
  } else {
    const msg = data.message || (typeof ev.data === "string" ? ev.data : "");
    label = (
      <span>
        {evType.replace(/_/g, " ")}
        {msg && <span className="text-[var(--fg-muted)]">{" -- " + msg}</span>}
      </span>
    );
  }

  return { id, timestamp, label, color, detail, rawData, stage: stageName || undefined };
}
