import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "../hooks/useApi.js";
import { useSessionDetailData } from "../hooks/useSessionDetailData.js";
import { useMessages } from "../hooks/useMessages.js";
import { relTime, fmtCost } from "../util.js";
import { cn } from "../lib/utils.js";

// UI components
import { SessionHeader } from "./ui/SessionHeader.js";
import { ContentTabs, type TabDef } from "./ui/ContentTabs.js";
import { ChatInput } from "./ui/ChatInput.js";
import { ScrollProgress } from "./ui/ScrollProgress.js";
import { AgentMessage } from "./ui/AgentMessage.js";
import { UserMessage } from "./ui/UserMessage.js";
import { SystemEvent } from "./ui/SystemEvent.js";
import { ToolCallRow } from "./ui/ToolCallRow.js";
import { ToolCallFailed } from "./ui/ToolCallFailed.js";
import { TypingIndicator } from "./ui/TypingIndicator.js";
import { SessionSummary } from "./ui/SessionSummary.js";
import { EventTimeline, type TimelineEvent } from "./ui/EventTimeline.js";
import { TodoList, type TodoItem } from "./ui/TodoList.js";
import type { StageProgress } from "./ui/StageProgressBar.js";
import type { SessionStatus } from "./ui/StatusDot.js";

interface SessionDetailProps {
  sessionId: string;
  onToast: (msg: string, type: string) => void;
  readOnly: boolean;
}

function normalizeStatus(s: string): SessionStatus {
  const valid: SessionStatus[] = ["running", "waiting", "completed", "failed", "stopped", "pending"];
  if (valid.includes(s as SessionStatus)) return s as SessionStatus;
  if (s === "blocked" || s === "ready") return "pending";
  return "stopped";
}

function buildStageProgress(session: any, flowStages: any[]): StageProgress[] {
  if (!flowStages || flowStages.length === 0) return [];
  const currentStage = session.stage;
  const currentIdx = flowStages.findIndex((s: any) => s.name === currentStage);
  const isFailed = session.status === "failed";
  const isCompleted = session.status === "completed";

  return flowStages.map((s: any, i: number) => {
    if (isCompleted) return { name: s.name, state: "done" as const };
    if (isFailed && i === currentIdx) return { name: s.name, state: "active" as const };
    if (currentIdx < 0) return { name: s.name, state: "pending" as const };
    if (i < currentIdx) return { name: s.name, state: "done" as const };
    if (i === currentIdx) return { name: s.name, state: "active" as const };
    return { name: s.name, state: "pending" as const };
  });
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Map session events into conversation timeline items. */
function buildConversationTimeline(events: any[], messages: any[]) {
  const items: any[] = [];

  // Merge events and messages by time
  const all: any[] = [];

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
        kind: item.role === "user" ? "user" : "agent",
        role: item.role,
        content: item.content,
        timestamp: formatTime(item.created_at),
        agentName: item.role === "user" ? "You" : item.agent_name || item.role || "assistant",
        model: item.model,
        type: item.type,
      });
    } else {
      // Event
      const evType = item.type || "";
      const evData = typeof item.data === "string" ? item.data : item.data?.message || "";
      const nested = typeof item.data === "object" ? item.data?.data : null;

      // Agent channel messages -- progress, completed, question, error
      if (evType === "agent_progress") {
        const msg = nested?.message || evData;
        if (msg) {
          items.push({
            kind: "agent",
            content: msg,
            timestamp: formatTime(item.created_at),
            agentName: nested?.stage || item.data?.stage || "agent",
            model: nested?.model,
            type: "progress",
          });
        }
      } else if (evType === "agent_completed") {
        const summary = nested?.summary || nested?.message || evData;
        const extras: string[] = [];
        if (nested?.pr_url) extras.push(`PR: ${nested.pr_url}`);
        if (Array.isArray(nested?.filesChanged) && nested.filesChanged.length > 0) {
          extras.push(`Files: ${nested.filesChanged.join(", ")}`);
        }
        const content = extras.length > 0 ? `${summary}\n${extras.join("\n")}` : summary;
        items.push({
          kind: "agent",
          content: content || "Stage completed",
          timestamp: formatTime(item.created_at),
          agentName: nested?.stage || item.data?.stage || "agent",
          model: nested?.model,
          type: "completed",
        });
      } else if (evType === "agent_question") {
        items.push({
          kind: "agent",
          content: nested?.question || evData || "Agent has a question",
          timestamp: formatTime(item.created_at),
          agentName: nested?.stage || item.data?.stage || "agent",
          model: undefined,
          type: "question",
        });
      } else if (evType === "agent_error") {
        items.push({
          kind: "system",
          content: `Error: ${nested?.error || evData || "Unknown error"}`,
          timestamp: formatTime(item.created_at),
        });
      } else if (evType.includes("stage_") || evType.includes("dispatch") || evType.includes("advance")) {
        // Stage transitions become system events
        items.push({
          kind: "system",
          content: evData || evType.replace(/_/g, " "),
          timestamp: formatTime(item.created_at),
        });
      } else if (evType.includes("tool")) {
        // Tool calls
        const isError = evType.includes("error") || evType.includes("fail");
        items.push({
          kind: "tool",
          label: evData || evType.replace(/_/g, " "),
          timestamp: formatTime(item.created_at),
          status: isError ? "error" : "done",
          duration: item.data?.duration ? `${(item.data.duration / 1000).toFixed(1)}s` : undefined,
          error: isError ? item.data?.error || evData : undefined,
        });
      } else if (
        evType.includes("completion_rejected") ||
        evType.includes("guardrail") ||
        evType.includes("retry") ||
        evType.includes("verification")
      ) {
        // Other notable system events
        items.push({
          kind: "system",
          content: evData || evType.replace(/_/g, " "),
          timestamp: formatTime(item.created_at),
        });
      }
    }
  }

  return items;
}

export function SessionDetail({ sessionId, onToast, readOnly }: SessionDetailProps) {
  const {
    detail,
    setDetail,
    todos,
    setTodos,
    messages: detailMessages,
    flowStages,
    cost,
    output,
  } = useSessionDetailData(sessionId);

  const [activeTab, setActiveTab] = useState("conversation");
  const [chatMsg, setChatMsg] = useState("");
  const [scrollProgress, setScrollProgress] = useState(0);
  const [diffData, setDiffData] = useState<any>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const session = detail?.session;
  const events = detail?.events || [];
  const isActive = session?.status === "running" || session?.status === "waiting";

  // Use messages hook for live chat
  const {
    messages: liveMessages,
    send,
    sending,
  } = useMessages({
    sessionId,
    enabled: isActive,
    pollMs: 2000,
  });

  // Build conversation timeline from events and messages.
  // For active sessions, prefer liveMessages (polled every 2s) over the static detailMessages.
  // For inactive sessions, use whichever has data.
  const conversationMessages =
    isActive && liveMessages.length > 0 ? liveMessages : detailMessages.length > 0 ? detailMessages : liveMessages;
  const timeline = buildConversationTimeline(events, conversationMessages);

  // Check if the last timeline item is from an agent -- if so, hide typing indicator
  // (it will reappear when the user sends a new message and there's no agent reply yet)
  const lastTimelineItem = timeline.length > 0 ? timeline[timeline.length - 1] : null;
  const agentIsTyping =
    isActive && (!lastTimelineItem || lastTimelineItem.kind === "user" || lastTimelineItem.kind === "system");

  // Scroll progress
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    setScrollProgress(max > 0 ? (el.scrollTop / max) * 100 : 0);
  }, []);

  // Auto-scroll on new messages
  useEffect(() => {
    if (bottomRef.current && activeTab === "conversation") {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [conversationMessages.length, activeTab]);

  // Load diff data when switching to diff tab
  useEffect(() => {
    if (activeTab === "diff" && !diffData && sessionId) {
      api
        .worktreeDiff(sessionId)
        .then(setDiffData)
        .catch(() => {});
    }
  }, [activeTab, diffData, sessionId]);

  // Handle actions
  async function handleAction(action: string) {
    try {
      let res: any;
      switch (action) {
        case "stop":
          res = await api.stop(sessionId);
          break;
        case "dispatch":
          res = await api.dispatch(sessionId);
          break;
        case "restart":
          res = await api.restart(sessionId);
          break;
        default:
          return;
      }
      if (res.ok !== false) {
        onToast(`${action} successful`, "success");
        const d = await api.getSession(sessionId);
        setDetail(d);
      } else {
        onToast(res.message || "Action failed", "error");
      }
    } catch (err: any) {
      onToast(err.message || "Action failed", "error");
    }
  }

  async function handleSend() {
    const text = chatMsg.trim();
    if (!text) return;
    setChatMsg("");
    const res = await send(text);
    if (res.ok === false) {
      onToast(res.message || "Send failed", "error");
    }
  }

  async function handleToggleTodo(id: number) {
    try {
      const res = await api.toggleTodo(id);
      if (res.ok !== false && res.todo) {
        setTodos(todos.map((t) => (t.id === id ? res.todo : t)));
      }
    } catch (err: any) {
      onToast(err.message || "Failed to toggle todo", "error");
    }
  }

  if (!session) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-[var(--fg-muted)]">Loading session...</div>
    );
  }

  const stages = buildStageProgress(session, flowStages);
  const completedStages = stages.filter((s) => s.state === "done").length;
  const totalStages = stages.length;
  const progressPct = totalStages > 0 ? Math.round((completedStages / totalStages) * 100) : 0;

  // Build tabs
  const tabs: TabDef[] = [
    { id: "conversation", label: "Conversation" },
    { id: "terminal", label: "Terminal" },
    { id: "events", label: "Events", badge: events.length > 0 ? events.length : undefined },
    {
      id: "diff",
      label: "Diff",
      badge: diffData?.filesChanged ? `+${diffData.insertions || 0}/-${diffData.deletions || 0}` : undefined,
    },
    { id: "todos", label: "Todos", badge: todos.length > 0 ? todos.length : undefined },
  ];

  // Map events for timeline tab
  const timelineEvents: TimelineEvent[] = events.slice(-100).map((ev: any, i: number) => ({
    id: String(ev.id || i),
    timestamp: formatTime(ev.created_at),
    label: `${ev.type?.replace(/_/g, " ")} ${typeof ev.data === "string" ? ev.data : ev.data?.message || ""}`.trim(),
    status: ev.type?.includes("fail") || ev.type?.includes("error") ? ("failed" as const) : ("running" as const),
  }));

  // Map todos
  const todoItems: TodoItem[] = todos.map((t: any) => ({
    id: String(t.id),
    text: t.content || t.text || "",
    done: !!t.done,
    priority: t.priority || undefined,
    source: t.source || undefined,
  }));

  // Actions for header
  const headerActions = (
    <div className="flex gap-1.5 shrink-0">
      {isActive && (
        <button
          type="button"
          onClick={() => handleAction("stop")}
          className={cn(
            "h-7 px-2.5 rounded-[var(--radius-sm)] text-[11px] font-medium",
            "border border-[var(--failed)] bg-transparent text-[var(--failed)]",
            "hover:bg-[var(--diff-rm-bg)] transition-colors cursor-pointer",
          )}
        >
          Stop
        </button>
      )}
      {(session.status === "ready" || session.status === "pending" || session.status === "blocked") && (
        <button
          type="button"
          onClick={() => handleAction("dispatch")}
          className={cn(
            "h-7 px-2.5 rounded-[var(--radius-sm)] text-[11px] font-medium",
            "border border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-fg)]",
            "hover:bg-[var(--primary-hover)] transition-colors cursor-pointer",
          )}
        >
          Dispatch
        </button>
      )}
      {(session.status === "stopped" || session.status === "failed" || session.status === "completed") && (
        <button
          type="button"
          onClick={() => handleAction("restart")}
          className={cn(
            "h-7 px-2.5 rounded-[var(--radius-sm)] text-[11px] font-medium",
            "border border-[var(--running)] bg-transparent text-[var(--running)]",
            "hover:bg-[var(--diff-add-bg)] transition-colors cursor-pointer",
          )}
        >
          Restart
        </button>
      )}
    </div>
  );

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[var(--bg)]">
      {/* Scroll Progress */}
      <ScrollProgress progress={scrollProgress} />

      {/* Session Header */}
      <SessionHeader
        sessionId={session.id}
        summary={session.summary || session.id}
        status={normalizeStatus(session.status)}
        stages={stages}
        cost={cost?.cost ? fmtCost(cost.cost) : undefined}
        actions={!readOnly ? headerActions : undefined}
        onCopyId={() => {
          navigator.clipboard.writeText(session.id);
          onToast("Copied session ID", "success");
        }}
      />

      {/* Meta row with progress */}
      {totalStages > 0 && (
        <div className="h-10 border-b border-[var(--border)] flex items-center px-5 gap-2.5 shrink-0">
          <span className="text-[11px] font-[family-name:var(--font-mono-ui)] text-[var(--fg-muted)]">
            {session.agent || "--"}
          </span>
          {session.flow && (
            <>
              <div className="w-px h-[18px] bg-[var(--border)]" />
              <span className="text-[11px] font-[family-name:var(--font-mono-ui)] text-[var(--fg-muted)]">
                {session.flow}
              </span>
            </>
          )}
          <div className="flex-1" />
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-[11px] font-[family-name:var(--font-mono-ui)] text-[var(--fg-muted)]">
              {completedStages}/{totalStages} stages
            </span>
            <div className="w-[60px] h-[3px] bg-[var(--border)] rounded-sm overflow-hidden">
              <div
                className="h-full bg-[var(--primary)] rounded-sm transition-[width] duration-300"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <span className="text-[11px] font-[family-name:var(--font-mono-ui)] font-semibold text-[var(--fg)] min-w-[28px] text-right">
              {progressPct}%
            </span>
          </div>
        </div>
      )}

      {/* Content Tabs */}
      <ContentTabs tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />

      {/* Tab Content */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6" onScroll={handleScroll}>
        {/* Conversation Tab */}
        {activeTab === "conversation" && (
          <div className="max-w-[720px] mx-auto">
            {timeline.length === 0 && conversationMessages.length === 0 && (
              <div className="text-center text-sm text-[var(--fg-muted)] py-12">
                No conversation yet. {isActive ? "The agent is working..." : ""}
              </div>
            )}
            {timeline.map((item, i) => {
              if (item.kind === "user") {
                return (
                  <UserMessage key={`u-${i}`} timestamp={item.timestamp}>
                    <p>{item.content}</p>
                  </UserMessage>
                );
              }
              if (item.kind === "agent") {
                return (
                  <AgentMessage key={`a-${i}`} agentName={item.agentName} model={item.model} timestamp={item.timestamp}>
                    <p>{item.content}</p>
                  </AgentMessage>
                );
              }
              if (item.kind === "system") {
                return <SystemEvent key={`s-${i}`}>{item.content}</SystemEvent>;
              }
              if (item.kind === "tool") {
                if (item.status === "error") {
                  return (
                    <ToolCallFailed key={`t-${i}`} label={item.label} duration={item.duration} error={item.error} />
                  );
                }
                return <ToolCallRow key={`t-${i}`} label={item.label} duration={item.duration} status={item.status} />;
              }
              return null;
            })}

            {/* Show raw messages if no events-based timeline */}
            {timeline.length === 0 &&
              conversationMessages.map((m, i) => {
                if (m.role === "user") {
                  return (
                    <UserMessage key={m.id || i} timestamp={formatTime(m.created_at)}>
                      <p>{m.content}</p>
                    </UserMessage>
                  );
                }
                return (
                  <AgentMessage
                    key={m.id || i}
                    agentName={m.agent_name || m.role || "assistant"}
                    model={m.model}
                    timestamp={formatTime(m.created_at)}
                  >
                    <p>{m.content}</p>
                  </AgentMessage>
                );
              })}

            {/* Typing indicator -- shows when session is active and last item isn't an agent message */}
            {agentIsTyping && <TypingIndicator agentName={session.agent} />}

            {/* Session summary for completed sessions */}
            {session.status === "completed" && cost && (
              <SessionSummary
                duration={relTime(session.created_at)}
                cost={fmtCost(cost.cost)}
                filesChanged={session.config?.filesChanged?.length || 0}
                testsPassed={session.config?.tests_passed}
                prLink={session.pr_url ? { href: session.pr_url, label: `View PR on GitHub` } : undefined}
              />
            )}

            <div ref={bottomRef} />
          </div>
        )}

        {/* Terminal Tab */}
        {activeTab === "terminal" && (
          <div className="font-[family-name:var(--font-mono)] text-[12px] text-[var(--fg-muted)] leading-[1.7]">
            {output ? (
              <pre className="whitespace-pre-wrap break-all">{output}</pre>
            ) : (
              <div className="text-center py-12 text-[var(--fg-faint)]">
                No terminal output available{isActive ? " yet" : ""}
              </div>
            )}
          </div>
        )}

        {/* Events Tab */}
        {activeTab === "events" && <EventTimeline events={timelineEvents} />}

        {/* Diff Tab */}
        {activeTab === "diff" && (
          <div className="max-w-[800px] mx-auto">
            {diffData ? (
              <div>
                <div className="text-[11px] text-[var(--fg-muted)] mb-3 font-[family-name:var(--font-mono)]">
                  {diffData.filesChanged} files changed, +{diffData.insertions || 0} -{diffData.deletions || 0}
                </div>
                {diffData.stat && (
                  <pre className="bg-[var(--bg-code)] border border-[var(--border)] rounded-lg p-3.5 font-[family-name:var(--font-mono)] text-[11px] leading-[1.7] overflow-auto whitespace-pre-wrap text-[var(--fg-muted)]">
                    {diffData.stat}
                  </pre>
                )}
              </div>
            ) : (
              <div className="text-center py-12 text-[var(--fg-faint)]">
                {session.workdir ? "Loading diff..." : "No worktree associated with this session"}
              </div>
            )}
          </div>
        )}

        {/* Todos Tab */}
        {activeTab === "todos" && <TodoList items={todoItems} onToggle={(id) => handleToggleTodo(Number(id))} />}
      </div>

      {/* Chat input - conversation tab only, active sessions only */}
      {activeTab === "conversation" && (
        <ChatInput
          value={chatMsg}
          onChange={setChatMsg}
          onSend={handleSend}
          disabled={!isActive || sending}
          disabledText={!isActive ? "Session is not running" : undefined}
          modelName={session.config?.model || session.agent}
        />
      )}

      {/* Tab footer for non-conversation tabs */}
      {activeTab === "events" && events.length > 0 && (
        <div className="border-t border-[var(--border)] px-6 py-2 shrink-0 bg-[var(--bg)] flex items-center gap-3 text-[11px] text-[var(--fg-muted)] font-[family-name:var(--font-mono-ui)]">
          <span>{events.length} events</span>
          <span className="ml-auto">Last: {formatTime(events[events.length - 1]?.created_at)}</span>
        </div>
      )}
      {activeTab === "diff" && diffData && (
        <div className="border-t border-[var(--border)] px-6 py-2 shrink-0 bg-[var(--bg)] flex items-center gap-3 text-[11px] text-[var(--fg-muted)] font-[family-name:var(--font-mono-ui)]">
          <span>{diffData.filesChanged} files changed</span>
          <span className="text-[var(--diff-add-fg)]">+{diffData.insertions || 0}</span>
          <span className="text-[var(--diff-rm-fg)]">-{diffData.deletions || 0}</span>
        </div>
      )}
      {activeTab === "todos" && todos.length > 0 && (
        <div className="border-t border-[var(--border)] px-6 py-2 shrink-0 bg-[var(--bg)] flex items-center gap-3 text-[11px] text-[var(--fg-muted)] font-[family-name:var(--font-mono-ui)]">
          <span>
            {todos.filter((t) => t.done).length} of {todos.length} completed
          </span>
          <span className="ml-auto">{todos.filter((t) => !t.done).length} remaining</span>
        </div>
      )}
    </div>
  );
}
