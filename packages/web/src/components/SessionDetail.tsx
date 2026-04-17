import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "../hooks/useApi.js";
import { useSessionDetailData } from "../hooks/useSessionDetailData.js";
import { useMessages } from "../hooks/useMessages.js";
import { relTime, fmtCost } from "../util.js";
import { cn } from "../lib/utils.js";
import { Loader2 } from "lucide-react";

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
import { DiffViewer, type DiffFile } from "./ui/DiffViewer.js";

// Extracted helpers
import {
  normalizeStatus,
  buildStageProgress,
  formatTime,
  parseUnifiedDiff,
  buildConversationTimeline,
} from "./session/timeline-builder.js";
import { renderAgentContent, buildRichTimelineEvent } from "./session/event-builder.js";

interface SessionDetailProps {
  sessionId: string;
  onToast: (msg: string, type: string) => void;
  readOnly: boolean;
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
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [stageFilter, setStageFilter] = useState<string | null>(null);
  const [activeDiffFile, setActiveDiffFile] = useState<string | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const session = detail?.session;
  const events = detail?.events || [];
  const isActive = session?.status === "running" || session?.status === "waiting";

  const { messages: liveMessages, send, sending } = useMessages({ sessionId, enabled: isActive, pollMs: 2000 });

  const conversationMessages =
    isActive && liveMessages.length > 0 ? liveMessages : detailMessages.length > 0 ? detailMessages : liveMessages;
  const fullTimeline = buildConversationTimeline(events, conversationMessages, session);
  const timeline = stageFilter
    ? fullTimeline.filter((item: any) => item.stage === stageFilter || item.kind === "user")
    : fullTimeline;

  // Show typing indicator only when agent has recent hook activity (last 10s)
  const lastHookTime = events
    .filter((ev: any) => ev.type === "hook_status")
    .reduce((latest: number, ev: any) => Math.max(latest, new Date(ev.created_at).getTime()), 0);
  const hasRecentActivity = lastHookTime > 0 && Date.now() - lastHookTime < 10_000;
  const agentIsTyping = isActive && hasRecentActivity;

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    setScrollProgress(max > 0 ? (el.scrollTop / max) * 100 : 0);
  }, []);

  useEffect(() => {
    if (bottomRef.current && activeTab === "conversation") {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [conversationMessages.length, activeTab]);

  useEffect(() => {
    let cancelled = false;
    if (activeTab === "diff" && !diffData && sessionId) {
      api
        .worktreeDiff(sessionId)
        .then((data) => {
          if (!cancelled) setDiffData(data);
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [activeTab, diffData, sessionId]);

  async function handleAction(action: string) {
    setActionLoading(action);
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
        onToast(action + " successful", "success");
        const d = await api.getSession(sessionId);
        setDetail(d);
      } else {
        onToast(res.message || "Action failed", "error");
      }
    } catch (err: any) {
      onToast(err.message || "Action failed", "error");
    } finally {
      setActionLoading(null);
    }
  }

  async function handleSend() {
    const text = chatMsg.trim();
    if (!text) return;
    setChatMsg("");
    const res = await send(text);
    if (res.ok === false) onToast(res.message || "Send failed", "error");
  }

  async function handleToggleTodo(id: number) {
    try {
      const res = await api.toggleTodo(id);
      if (res.ok !== false && res.todo) setTodos(todos.map((t) => (t.id === id ? res.todo : t)));
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

  const tabs: TabDef[] = [
    { id: "conversation", label: "Conversation" },
    { id: "terminal", label: "Terminal" },
    { id: "events", label: "Events", badge: events.length > 0 ? events.length : undefined },
    {
      id: "diff",
      label: "Diff",
      badge: diffData?.filesChanged ? "+" + (diffData.insertions || 0) + "/-" + (diffData.deletions || 0) : undefined,
    },
    { id: "todos", label: "Todos", badge: todos.length > 0 ? todos.length : undefined },
  ];

  // Build rich timeline events for the Events tab
  const timelineEvents: TimelineEvent[] = events.slice(-200).map((ev: any, i: number) => {
    return buildRichTimelineEvent(ev, i);
  });

  const todoItems: TodoItem[] = todos.map((t: any) => ({
    id: String(t.id),
    text: t.content || t.text || "",
    done: !!t.done,
    priority: t.priority || undefined,
    source: t.source || undefined,
  }));

  // Parse diff for DiffViewer when available
  const diffFiles: DiffFile[] = diffData?.diff ? parseUnifiedDiff(diffData.diff) : [];

  const headerActions = (
    <div className="flex gap-1.5 shrink-0">
      {isActive && (
        <button
          type="button"
          onClick={() => handleAction("stop")}
          disabled={actionLoading === "stop"}
          aria-label="Stop session"
          className={cn(
            "h-7 px-2.5 rounded-[var(--radius-sm)] text-[11px] font-medium",
            "border border-[var(--failed)] bg-transparent text-[var(--failed)]",
            "hover:bg-[var(--diff-rm-bg)] transition-colors cursor-pointer",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            "flex items-center gap-1",
          )}
        >
          {actionLoading === "stop" ? (
            <>
              <Loader2 className="animate-spin" size={12} /> Stopping...
            </>
          ) : (
            "Stop"
          )}
        </button>
      )}
      {(session.status === "ready" || session.status === "pending" || session.status === "blocked") && (
        <button
          type="button"
          onClick={() => handleAction("dispatch")}
          disabled={actionLoading === "dispatch"}
          aria-label="Dispatch session"
          className={cn(
            "h-7 px-2.5 rounded-[var(--radius-sm)] text-[11px] font-medium",
            "border border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-fg)]",
            "hover:bg-[var(--primary-hover)] transition-colors cursor-pointer",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            "flex items-center gap-1",
          )}
        >
          {actionLoading === "dispatch" ? (
            <>
              <Loader2 className="animate-spin" size={12} /> Dispatching...
            </>
          ) : (
            "Dispatch"
          )}
        </button>
      )}
      {(session.status === "stopped" || session.status === "failed" || session.status === "completed") && (
        <button
          type="button"
          onClick={() => handleAction("restart")}
          disabled={actionLoading === "restart"}
          aria-label="Restart session"
          className={cn(
            "h-7 px-2.5 rounded-[var(--radius-sm)] text-[11px] font-medium",
            "border border-[var(--running)] bg-transparent text-[var(--running)]",
            "hover:bg-[var(--diff-add-bg)] transition-colors cursor-pointer",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            "flex items-center gap-1",
          )}
        >
          {actionLoading === "restart" ? (
            <>
              <Loader2 className="animate-spin" size={12} /> Restarting...
            </>
          ) : (
            "Restart"
          )}
        </button>
      )}
    </div>
  );

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[var(--bg)]">
      <ScrollProgress progress={scrollProgress} />
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
        selectedStage={stageFilter}
        onStageClick={(stageName) => {
          setStageFilter(stageFilter === stageName ? null : stageName);
        }}
      />

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
                style={{ width: progressPct + "%" }}
              />
            </div>
            <span className="text-[11px] font-[family-name:var(--font-mono-ui)] font-semibold text-[var(--fg)] min-w-[28px] text-right">
              {progressPct}%
            </span>
          </div>
        </div>
      )}

      <ContentTabs tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6" onScroll={handleScroll}>
        {activeTab === "conversation" && (
          <div className="max-w-[720px] mx-auto">
            {timeline.length === 0 && conversationMessages.length === 0 && (
              <div className="text-center text-sm text-[var(--fg-muted)] py-12">
                No conversation yet. {isActive ? "The agent is working..." : ""}
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
              if (item.kind === "system") return <SystemEvent key={"s-" + i}>{item.content}</SystemEvent>;
              if (item.kind === "tool") {
                if (item.status === "error")
                  return (
                    <ToolCallFailed key={"t-" + i} label={item.label} duration={item.duration} error={item.error} />
                  );
                return <ToolCallRow key={"t-" + i} label={item.label} duration={item.duration} status={item.status} />;
              }
              return null;
            })}
            {timeline.length === 0 &&
              conversationMessages.map((m, i) => {
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
                    <p>{m.content}</p>
                  </AgentMessage>
                );
              })}
            {agentIsTyping && <TypingIndicator agentName={session.agent || "agent"} />}
            {session.status === "completed" && cost && (
              <SessionSummary
                duration={relTime(session.created_at)}
                cost={fmtCost(cost.cost)}
                filesChanged={session.config?.filesChanged?.length || 0}
                testsPassed={session.config?.tests_passed}
                prLink={session.pr_url ? { href: session.pr_url, label: "View PR on GitHub" } : undefined}
              />
            )}
            <div ref={bottomRef} />
          </div>
        )}
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
        {activeTab === "events" && (
          <EventTimeline
            events={timelineEvents}
            onStageClick={(stage) => {
              setStageFilter(stageFilter === stage ? null : stage);
              setActiveTab("conversation");
            }}
          />
        )}
        {activeTab === "diff" && (
          <div className="max-w-[800px] mx-auto">
            {diffData ? (
              <div>
                <div className="text-[11px] text-[var(--fg-muted)] mb-3 font-[family-name:var(--font-mono)]">
                  {diffData.filesChanged} files changed, +{diffData.insertions || 0} -{diffData.deletions || 0}
                </div>
                {diffFiles.length > 0 ? (
                  <DiffViewer
                    files={diffFiles}
                    activeFile={activeDiffFile}
                    onFileSelect={setActiveDiffFile}
                    className="border border-[var(--border)] rounded-lg overflow-hidden"
                  />
                ) : diffData.stat ? (
                  <pre className="bg-[var(--bg-code)] border border-[var(--border)] rounded-lg p-3.5 font-[family-name:var(--font-mono)] text-[11px] leading-[1.7] overflow-auto whitespace-pre-wrap text-[var(--fg-muted)]">
                    {diffData.stat}
                  </pre>
                ) : null}
              </div>
            ) : (
              <div className="text-center py-12 text-[var(--fg-faint)]">
                {session.workdir ? "Loading diff..." : "No worktree associated with this session"}
              </div>
            )}
          </div>
        )}
        {activeTab === "todos" && <TodoList items={todoItems} onToggle={(id) => handleToggleTodo(Number(id))} />}
      </div>

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
