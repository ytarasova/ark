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
import { formatTime } from "../timeline-builder.js";
import { renderAgentContent } from "../event-builder.js";
import { SdkTranscriptPanel } from "../SdkTranscriptPanel.js";

interface ConversationTabProps {
  session: any;
  timeline: any[];
  conversationMessages: any[];
  events: any[];
  cost: { cost: number; tokens_in?: number; tokens_out?: number } | null | undefined;
  isActive: boolean;
  agentIsTyping: boolean;
  bottomRef: React.RefObject<HTMLDivElement>;
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
}: ConversationTabProps) {
  const attachments = (session?.config?.attachments ?? []) as Array<{ name: string; content: string; type: string }>;

  // agent-sdk sessions also write a raw transcript.jsonl next to their
  // events. Render those SDK-shaped messages inline above the timeline so
  // we keep the existing event-based view for every other runtime.
  const runtime = session?.runtime ?? session?.agent_runtime;
  const isAgentSdk = runtime === "agent-sdk";

  return (
    <div className="max-w-[720px] mx-auto">
      {attachments.length > 0 && <AttachedFiles attachments={attachments} />}
      {isAgentSdk && <SdkTranscriptPanel sessionId={session.id} status={session.status} isRunning={isActive} />}
      {timeline.length === 0 && conversationMessages.length === 0 && (
        <div className="text-center text-sm text-[var(--fg-muted)] py-12">
          No conversation yet.{" "}
          {isActive ? "The agent is working... Switch to the Terminal tab to see live output." : ""}
        </div>
      )}
      {timeline.length > 0 && timeline.every((item: any) => item.kind === "system") && isActive && (
        <div className="text-center text-[12px] text-[var(--fg-muted)] py-4 mt-2 border border-dashed border-[var(--border)] rounded-lg">
          {session.agent || "Agent"} is working... Switch to the Terminal tab to see live output.
        </div>
      )}
      {timeline.map((item, i) => {
        if (item.kind === "user")
          return (
            <UserMessage key={"u-" + i} timestamp={item.timestamp}>
              <p>{item.content}</p>
            </UserMessage>
          );
        if (item.kind === "agent")
          return (
            <AgentMessage key={"a-" + i} agentName={item.agentName} model={item.model} timestamp={item.timestamp}>
              {renderAgentContent(item.content, item.type)}
            </AgentMessage>
          );
        if (item.kind === "system") {
          // Payload behind the row -- shown when the user expands the card.
          // Fall back to the whole event if there's no data object.
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
            return <ToolCallFailed key={"t-" + i} label={item.label} duration={item.duration} error={item.error} />;
          return <ToolCallRow key={"t-" + i} label={item.label} duration={item.duration} status={item.status} />;
        }
        return null;
      })}
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
              agentName={m.agent_name || session.agent || m.role || "assistant"}
              model={m.model}
              timestamp={formatTime(m.created_at)}
            >
              <MarkdownContent content={m.content} />
            </AgentMessage>
          );
        })}
      {agentIsTyping && <TypingIndicator agentName={session.agent || "agent"} />}
      {session.status === "completed" && cost && (
        <SessionSummary
          duration={(() => {
            // Use actual run time: last event time - first event time (or created_at)
            if (events.length > 1) {
              const start = new Date(events[0].created_at).getTime();
              const end = new Date(events[events.length - 1].created_at).getTime();
              const mins = Math.round((end - start) / 60000);
              if (mins < 60) return `${mins}m`;
              return `${Math.floor(mins / 60)}h ${mins % 60}m`;
            }
            return fmtDuration(session.created_at);
          })()}
          cost={fmtCost(cost.cost)}
          filesChanged={session.config?.filesChanged?.length || 0}
          testsPassed={session.config?.tests_passed}
          prLink={session.pr_url ? { href: session.pr_url, label: "View PR on GitHub" } : undefined}
        />
      )}
      <div ref={bottomRef} />
    </div>
  );
}
