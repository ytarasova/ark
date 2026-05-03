import { fmtCost, fmtDuration } from "../../../util.js";
import { AgentMessage } from "../../ui/AgentMessage.js";
import { MarkdownContent } from "../../ui/MarkdownContent.js";
import { UserMessage } from "../../ui/UserMessage.js";
import { SystemEvent } from "../../ui/SystemEvent.js";
import { ToolCallRow } from "../../ui/ToolCallRow.js";
import { ToolCallFailed } from "../../ui/ToolCallFailed.js";
import { ToolBlock } from "../tool-block/index.js";
import { TypingIndicator } from "../../ui/TypingIndicator.js";
import { SessionSummary } from "../../ui/SessionSummary.js";
import { AttachedFiles } from "../AttachedFiles.js";
import { formatTime, groupTimelineByStage } from "../timeline-builder.js";
import { renderAgentContent } from "../event-builder.js";
import { friendlyAgentName } from "../../../lib/inline-display.js";
import { StageGroupHeader } from "../StageGroupHeader.js";

interface ConversationTabProps {
  session: any;
  timeline: any[];
  conversationMessages: any[];
  events: any[];
  // costs/session RPC returns input_tokens/output_tokens; legacy callers use
  // tokens_in/tokens_out. Either shape works.
  cost:
    | {
        cost: number;
        input_tokens?: number;
        output_tokens?: number;
        tokens_in?: number;
        tokens_out?: number;
      }
    | null
    | undefined;
  isActive: boolean;
  agentIsTyping: boolean;
  bottomRef: React.RefObject<HTMLDivElement>;
  /** Files changed in the worktree (from git diff). Used as a fallback when
   *  the agent didn't report `filesChanged` via the channel. */
  filesChangedCount?: number;
  /** Canonical flow stage definitions ({name, agent, gate, ...} per stage)
   *  from FlowStore. Used to compute "stage N/M" counters against the
   *  flow's authoritative ordering instead of trusting whatever named
   *  stages happen to appear in the event stream. */
  flowStages?: any[];
}

/**
 * Conversation view for a session. Shows attached files, the merged
 * user/agent/tool/system timeline, a typing indicator while the agent is
 * working, and a completion summary (duration + cost + files + PR link).
 *
 * The `timeline` is a pre-built array from `buildConversationTimeline`;
 * this component only renders it.
 */
export function ConversationTab({
  session,
  timeline,
  conversationMessages,
  events,
  cost,
  isActive,
  agentIsTyping,
  bottomRef,
  filesChangedCount,
  flowStages: flowStageDefs,
}: ConversationTabProps) {
  const attachments = (session?.config?.attachments ?? []) as Array<{ name: string; content: string; type: string }>;
  // Resolve a display label that doesn't leak the literal "inline" placeholder
  // ("inline is typing" reads as a bug). Falls back to the inline-flow stage's
  // runtime name (e.g. "agent-sdk") and finally to a generic "agent".
  const displayAgent = friendlyAgentName(session) ?? "agent";

  // agent-sdk narration used to render via the SdkTranscriptPanel above the
  // timeline. Now that the runtime emits AgentMessage hooks that flow into
  // the timeline as inline `kind: "agent"` items, the panel just duplicates
  // the same text. The timeline path is authoritative; the legacy panel is
  // gone.

  return (
    <div className="max-w-[720px] mx-auto">
      {attachments.length > 0 && <AttachedFiles attachments={attachments} />}
      {timeline.length === 0 && conversationMessages.length === 0 && (
        <div className="text-center text-sm text-[var(--fg-muted)] py-12">
          No conversation yet.{" "}
          {isActive ? "The agent is working... Switch to the Terminal tab to see live output." : ""}
        </div>
      )}
      {timeline.length > 0 && timeline.every((item: any) => item.kind === "system") && isActive && (
        <div className="text-center text-[12px] text-[var(--fg-muted)] py-4 mt-2 border border-dashed border-[var(--border)] rounded-lg">
          {displayAgent} is working... Switch to the Terminal tab to see live output.
        </div>
      )}
      {(() => {
        // Canonical flow stage list -- the source of truth for "stage N/M"
        // counters and which stages can legitimately appear at all. Falls
        // back to the named groups in the event stream when the flow def
        // isn't on hand (inline flows, transient render).
        const canonicalNames: string[] = Array.isArray(flowStageDefs)
          ? flowStageDefs.map((s: any) => (typeof s?.name === "string" ? s.name : null)).filter((s): s is string => !!s)
          : [];
        const groups = groupTimelineByStage(timeline, events ?? [], session, canonicalNames);
        const namedGroups = groups.filter((g) => g.name != null);
        const totalStages = canonicalNames.length > 0 ? canonicalNames.length : namedGroups.length;
        const indexOf = (name: string | null): number | undefined => {
          if (name == null) return undefined;
          if (canonicalNames.length > 0) {
            const i = canonicalNames.indexOf(name);
            return i >= 0 ? i : undefined;
          }
          return namedGroups.findIndex((g) => g.name === name);
        };
        // Hide stage groups that aren't in the canonical flow ordering.
        // Sessions that lived through pre-fix bugs have events stamped
        // with stage names that no longer exist in the flow (#435 repro:
        // events stamped "merge" after the flow's merge action stage was
        // removed; or stages from the old action-based flow before the
        // pr-handler agent migration). Showing those produces impossible
        // displays like "STAGE 3/4 pr DONE" while STAGE 2 is still
        // running. The Setup (null-named) bucket always renders.
        const visible =
          canonicalNames.length > 0 ? groups.filter((g) => g.name == null || canonicalNames.includes(g.name)) : groups;
        return visible.map((group, gi) => (
          <StageGroupHeader
            key={`stage-${gi}-${group.name ?? "setup"}`}
            group={group}
            index={indexOf(group.name)}
            total={group.name != null ? totalStages : undefined}
          >
            {group.items.map((item: any, i: number) => {
              if (item.kind === "user")
                return (
                  <UserMessage key={"u-" + i} timestamp={item.timestamp}>
                    <p>{item.content}</p>
                  </UserMessage>
                );
              if (item.kind === "agent")
                return (
                  <AgentMessage
                    key={"a-" + i}
                    agentName={item.agentName}
                    model={item.model}
                    timestamp={item.timestamp}
                    isThinking={item.isThinking}
                  >
                    {renderAgentContent(item.content, item.type)}
                  </AgentMessage>
                );
              if (item.kind === "system") {
                const details = item.rawEvent ? (item.rawEvent.data ?? item.rawEvent) : undefined;
                return (
                  <SystemEvent key={"s-" + i} timestamp={item.timestamp} stage={item.stage} details={details}>
                    {item.content}
                  </SystemEvent>
                );
              }
              if (item.kind === "tool") {
                if (item.toolName) {
                  const blockStatus =
                    item.status === "running"
                      ? "running"
                      : item.status === "error"
                        ? "err"
                        : item.status === "interrupted"
                          ? "incomplete"
                          : "ok";
                  return (
                    <ToolBlock
                      key={"t-" + i}
                      name={item.toolName}
                      input={item.toolInput}
                      output={item.toolOutput}
                      status={blockStatus}
                      durationMs={item.durationMs}
                      elapsed={item.duration}
                    />
                  );
                }
                if (item.status === "error")
                  return (
                    <ToolCallFailed key={"t-" + i} label={item.label} duration={item.duration} error={item.error} />
                  );
                return <ToolCallRow key={"t-" + i} label={item.label} duration={item.duration} status={item.status} />;
              }
              return null;
            })}
          </StageGroupHeader>
        ));
      })()}
      {timeline.length === 0 &&
        conversationMessages.map((m: any, i: number) => {
          if (m.role === "user")
            return (
              <UserMessage key={m.id || i} timestamp={formatTime(m.created_at)}>
                <p>{m.content}</p>
              </UserMessage>
            );
          return (
            <AgentMessage
              key={m.id || i}
              agentName={
                m.agent_name ||
                (session.agent && session.agent !== "inline" ? session.agent : null) ||
                m.role ||
                displayAgent
              }
              model={m.model}
              timestamp={formatTime(m.created_at)}
            >
              <MarkdownContent content={m.content} />
            </AgentMessage>
          );
        })}
      {agentIsTyping && <TypingIndicator agentName={displayAgent} />}
      {session.status === "completed" && cost && (
        <SessionSummary
          duration={(() => {
            // Use actual run time: last event time - first event time (or created_at).
            // Show seconds for sub-minute sessions instead of rounding to "0m".
            if (events.length > 1) {
              const start = new Date(events[0].created_at).getTime();
              const end = new Date(events[events.length - 1].created_at).getTime();
              const elapsedMs = end - start;
              if (elapsedMs < 60_000) {
                const secs = Math.max(1, Math.round(elapsedMs / 1000));
                return `${secs}s`;
              }
              const mins = Math.round(elapsedMs / 60_000);
              if (mins < 60) return `${mins}m`;
              return `${Math.floor(mins / 60)}h ${mins % 60}m`;
            }
            return fmtDuration(session.created_at);
          })()}
          cost={fmtCost(cost.cost)}
          filesChanged={
            // Channel-reported list (legacy claude-runtime) wins when set;
            // fall back to the worktree git diff count for agent-sdk + any
            // runtime that doesn't emit a `report` with filesChanged.
            session.config?.filesChanged?.length || filesChangedCount || 0
          }
          testsPassed={session.config?.tests_passed}
          prLink={session.pr_url ? { href: session.pr_url, label: "View PR on GitHub" } : undefined}
        />
      )}
      <div ref={bottomRef} />
    </div>
  );
}
