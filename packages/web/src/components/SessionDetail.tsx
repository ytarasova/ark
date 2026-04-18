import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "../hooks/useApi.js";
import { useSessionDetailData } from "../hooks/useSessionDetailData.js";
import { useMessages } from "../hooks/useMessages.js";
import { fmtCost, fmtDuration } from "../util.js";
import { cn } from "../lib/utils.js";
import { Loader2 } from "lucide-react";

// UI components
import { SessionHeader } from "./ui/SessionHeader.js";
import { ContentTabs, tabButtonId, tabPanelId, type TabDef } from "./ui/ContentTabs.js";
import { ChatInput } from "./ui/ChatInput.js";
import { ScrollProgress } from "./ui/ScrollProgress.js";
import { AgentMessage } from "./ui/AgentMessage.js";
import { MarkdownContent } from "./ui/MarkdownContent.js";
import { UserMessage } from "./ui/UserMessage.js";
import { SystemEvent } from "./ui/SystemEvent.js";
import { ToolCallRow } from "./ui/ToolCallRow.js";
import { ToolCallFailed } from "./ui/ToolCallFailed.js";
import { TypingIndicator } from "./ui/TypingIndicator.js";
import { SessionSummary } from "./ui/SessionSummary.js";
import { EventTimeline, type TimelineEvent } from "./ui/EventTimeline.js";
import { DetailDrawer } from "./ui/DetailDrawer.js";
import { TodoList, type TodoItem } from "./ui/TodoList.js";
import { DiffViewer, type DiffFile } from "./ui/DiffViewer.js";
import { StaticTerminal } from "./StaticTerminal.js";

// Extracted helpers
import {
  normalizeStatus,
  buildStageProgress,
  formatTime,
  parseUnifiedDiff,
  buildConversationTimeline,
} from "./session/timeline-builder.js";
import { renderAgentContent, buildRichTimelineEvent } from "./session/event-builder.js";

// ---------------------------------------------------------------------------
// Attached files display
// ---------------------------------------------------------------------------
function AttachedFiles({ attachments }: { attachments: Array<{ name: string; content: string; type: string }> }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  return (
    <div className="mb-4 border border-[var(--border)] rounded-lg overflow-hidden">
      <div className="px-3 py-2 bg-[var(--bg-hover)] border-b border-[var(--border)]">
        <span className="text-[11px] font-semibold text-[var(--fg-muted)] uppercase tracking-[0.04em]">
          Attached Files ({attachments.length})
        </span>
      </div>
      {attachments.map((att) => {
        const isBinary = att.content?.startsWith("data:");
        const isOpen = expanded[att.name] ?? false;
        return (
          <div key={att.name} className="border-b border-[var(--border)] last:border-b-0">
            <button
              type="button"
              className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
              onClick={() => setExpanded((prev) => ({ ...prev, [att.name]: !prev[att.name] }))}
            >
              <span className="text-[12px] font-medium text-[var(--fg)]">{att.name}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-hover)] text-[var(--fg-muted)] font-[family-name:var(--font-mono-ui)]">
                {att.type || "unknown"}
              </span>
              <span className="ml-auto text-[10px] text-[var(--fg-muted)]">{isOpen ? "collapse" : "expand"}</span>
            </button>
            {isOpen && (
              <div className="px-3 pb-2">
                {isBinary ? (
                  <span className="text-[11px] text-[var(--fg-muted)] italic">
                    Binary file -- preview not available
                  </span>
                ) : (
                  <pre className="text-[11px] leading-relaxed text-[var(--fg)] bg-[var(--bg)] rounded p-2 overflow-x-auto max-h-[300px] overflow-y-auto whitespace-pre-wrap font-[family-name:var(--font-mono-ui)]">
                    {att.content}
                  </pre>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface ErrorInfo {
  type: string;
  message?: string;
  stage?: string;
  timestamp?: string;
  detail?: string;
  agent?: string;
}

function ErrorRow({ type, message, stage, timestamp, onSelect }: ErrorInfo & { onSelect?: () => void }) {
  return (
    <div className="border-l-2 border-l-[var(--failed)] border-b border-b-[var(--border)]">
      <div className="flex items-center gap-2 py-2 px-3 cursor-pointer hover:bg-[var(--bg-hover)]" onClick={onSelect}>
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span className="text-[12px] font-semibold text-[var(--fg)] shrink-0">{type}</span>
          {message && <span className="text-[12px] text-[var(--fg-muted)] truncate min-w-0">{message}</span>}
          {stage && (
            <span className="shrink-0 text-[10px] font-[family-name:var(--font-mono-ui)] px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-[var(--bg-hover)] text-[var(--fg-muted)]">
              {stage}
            </span>
          )}
        </div>
        {timestamp && (
          <span className="shrink-0 text-[10px] text-[var(--fg-muted)] font-[family-name:var(--font-mono-ui)] tabular-nums">
            {timestamp}
          </span>
        )}
      </div>
    </div>
  );
}

interface SessionDetailProps {
  sessionId: string;
  onToast: (msg: string, type: string) => void;
  readOnly: boolean;
  initialTab?: string | null;
  onTabChange?: (tab: string | null) => void;
}

export function SessionDetail({ sessionId, onToast, readOnly, initialTab, onTabChange }: SessionDetailProps) {
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

  const VALID_TABS = new Set(["conversation", "terminal", "events", "diff", "todos", "errors"]);
  const [activeTab, setActiveTabInternal] = useState(
    initialTab && VALID_TABS.has(initialTab) ? initialTab : "conversation",
  );
  const setActiveTab = useCallback(
    (tab: string) => {
      setActiveTabInternal(tab);
      onTabChange?.(tab === "conversation" ? null : tab);
    },
    [onTabChange],
  );
  const [chatMsg, setChatMsg] = useState("");
  const [scrollProgress, setScrollProgress] = useState(0);
  const [diffData, setDiffData] = useState<any>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [stageFilter, setStageFilter] = useState<string | null>(null);
  const [activeDiffFile, setActiveDiffFile] = useState<string | undefined>(undefined);
  const [selectedEvent, setSelectedEvent] = useState<TimelineEvent | null>(null);
  const [selectedError, setSelectedError] = useState<ErrorInfo | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevMsgCountRef = useRef<number | null>(null);

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
    const count = conversationMessages.length;
    const prev = prevMsgCountRef.current;
    prevMsgCountRef.current = count;
    // Only auto-scroll when new messages arrive on an active session, not on initial load
    if (prev === null || prev === count) return;
    if (bottomRef.current && activeTab === "conversation" && isActive) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [conversationMessages.length, activeTab, isActive]);

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
        onToast(`Session ${sessionId} ${action} successful`, "success");
        const d = await api.getSession(sessionId);
        setDetail(d);
      } else {
        const hint =
          action === "dispatch"
            ? ". Check that the conductor is running: ark server daemon start"
            : action === "stop"
              ? ". The session may have already exited"
              : "";
        onToast(`Failed to ${action} session ${sessionId}: ${res.message || "unknown error"}${hint}`, "error");
      }
    } catch (err: any) {
      const hint = action === "dispatch" ? ". Check that the conductor is running: ark server daemon start" : "";
      onToast(`Failed to ${action} session ${sessionId}: ${err.message || "network error"}${hint}`, "error");
    } finally {
      setActionLoading(null);
    }
  }

  async function handleSend(attachments?: { name: string; dataUrl: string }[]) {
    let content = chatMsg.trim();
    // Append pasted images as data URLs in the content
    if (attachments && attachments.length > 0) {
      const imageRefs = attachments.map((a) => `\n[image: ${a.name}]\n${a.dataUrl}`).join("\n");
      content = content ? content + imageRefs : imageRefs.trim();
    }
    if (!content) return;
    setChatMsg("");
    const res = await send(content);
    if (res.ok === false)
      onToast(`Send to ${sessionId} failed: ${res.message || "session may not be running"}`, "error");
  }

  async function handleToggleTodo(id: number) {
    try {
      const res = await api.toggleTodo(id);
      if (res.ok !== false && res.todo) setTodos(todos.map((t) => (t.id === id ? res.todo : t)));
    } catch (err: any) {
      onToast(`Failed to toggle todo: ${err.message || "network error"}`, "error");
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

  // Collect errors from events and session
  const errorEvents = events.filter(
    (ev: any) => ev.type === "error" || ev.type === "action_failed" || (ev.data?.error && ev.type !== "hook_status"),
  );
  const hasErrors = session.status === "failed" || errorEvents.length > 0;

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
    ...(hasErrors
      ? [{ id: "errors", label: "Errors", badge: (errorEvents.length || 1) as number | string | undefined }]
      : []),
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
    <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-[var(--bg)]">
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

      <ContentTabs tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} ariaLabel="Session detail tabs" />

      <div
        ref={scrollRef}
        role="tabpanel"
        id={tabPanelId(activeTab)}
        aria-labelledby={tabButtonId(activeTab)}
        tabIndex={0}
        className={cn(
          "flex-1 min-h-0",
          activeTab === "terminal" ? "flex flex-col overflow-hidden p-2" : "overflow-y-auto px-6 py-6",
          "focus-visible:outline-none",
        )}
        onScroll={handleScroll}
      >
        {activeTab === "conversation" && (
          <div className="max-w-[720px] mx-auto">
            {/* Attached files */}
            {session?.config?.attachments &&
              (session.config.attachments as Array<{ name: string; content: string; type: string }>).length > 0 && (
                <AttachedFiles
                  attachments={session.config.attachments as Array<{ name: string; content: string; type: string }>}
                />
              )}
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
                    <MarkdownContent content={m.content} />
                  </AgentMessage>
                );
              })}
            {agentIsTyping && <TypingIndicator agentName={session.agent || "agent"} />}
            {session.status === "completed" && cost && (
              <SessionSummary
                duration={(() => {
                  // Use actual run time: last event time - first event time (or created_at)
                  const evts = detail?.events || [];
                  if (evts.length > 1) {
                    const start = new Date(evts[0].created_at).getTime();
                    const end = new Date(evts[evts.length - 1].created_at).getTime();
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
        )}
        {activeTab === "terminal" && (
          <div className="flex-1 min-h-0">
            {output ? (
              <StaticTerminal output={output} />
            ) : (
              <div className="text-center py-12 text-[var(--fg-faint)] font-[family-name:var(--font-mono)] text-[12px]">
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
            onEventSelect={(event) => setSelectedEvent(event)}
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
        {activeTab === "errors" && (
          <div className="max-w-[800px] mx-auto flex flex-col">
            {session.status === "failed" && session.error && (
              <ErrorRow
                type="Session Failed"
                message={session.error.length > 100 ? session.error.slice(0, 100) + "..." : session.error}
                stage={session.stage}
                detail={session.error}
                onSelect={() =>
                  setSelectedError({
                    type: "Session Failed",
                    message: session.error,
                    stage: session.stage,
                    detail: session.error,
                    agent: session.agent,
                  })
                }
              />
            )}
            {errorEvents.map((ev: any, i: number) => (
              <ErrorRow
                key={ev.id || i}
                type={ev.type}
                message={ev.data?.error || ev.data?.message}
                stage={ev.stage}
                timestamp={formatTime(ev.created_at)}
                detail={ev.data?.error || ev.data?.message || JSON.stringify(ev.data, null, 2)}
                onSelect={() =>
                  setSelectedError({
                    type: ev.type,
                    message: ev.data?.error || ev.data?.message,
                    stage: ev.stage,
                    timestamp: formatTime(ev.created_at),
                    detail: ev.data?.error || ev.data?.message || JSON.stringify(ev.data, null, 2),
                    agent: ev.data?.agent || ev.actor,
                  })
                }
              />
            ))}
            {!session.error && errorEvents.length === 0 && (
              <div className="text-center py-12 text-[var(--fg-faint)]">No errors</div>
            )}
          </div>
        )}
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
          <button
            type="button"
            onClick={() => {
              const exportData = events.map((ev: any) => ({
                id: ev.id,
                type: ev.type,
                stage: ev.stage,
                actor: ev.actor,
                data: ev.data,
                created_at: ev.created_at,
              }));
              const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `${session.id}-events.json`;
              a.click();
              URL.revokeObjectURL(url);
              onToast("Events exported", "success");
            }}
            className={cn(
              "px-2 py-0.5 rounded-[var(--radius-sm)] text-[10px] font-medium",
              "border border-[var(--border)] bg-transparent text-[var(--fg-muted)]",
              "hover:bg-[var(--bg-hover)] hover:text-[var(--fg)] transition-colors cursor-pointer",
            )}
          >
            Export JSON
          </button>
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

      {/* Event detail drawer */}
      <DetailDrawer open={!!selectedEvent} onClose={() => setSelectedEvent(null)} title="Event Detail">
        {selectedEvent && (
          <div className="flex flex-col gap-4">
            <div>
              <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--fg-muted)]">Type</span>
              <div className="mt-1 text-[13px] font-semibold text-[var(--fg)]">
                {selectedEvent.eventType || selectedEvent.id}
              </div>
            </div>

            {selectedEvent.stage && (
              <div>
                <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--fg-muted)]">
                  Stage
                </span>
                <div className="mt-1">
                  <span className="text-[11px] font-[family-name:var(--font-mono-ui)] px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-[var(--bg-hover)] text-[var(--fg-muted)]">
                    {selectedEvent.stage}
                  </span>
                </div>
              </div>
            )}

            <div>
              <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--fg-muted)]">
                Timestamp
              </span>
              <div className="mt-1 text-[12px] font-[family-name:var(--font-mono-ui)] text-[var(--fg)]">
                {selectedEvent.timestamp}
              </div>
            </div>

            {selectedEvent.detail && (
              <div>
                <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--fg-muted)]">
                  Detail
                </span>
                <pre className="mt-1 rounded-[var(--radius-sm)] bg-[var(--bg-code)] border border-[var(--border)] p-3 text-[11px] font-[family-name:var(--font-mono)] text-[var(--fg-muted)] leading-[1.7] whitespace-pre-wrap break-words overflow-auto max-h-[300px]">
                  {selectedEvent.detail}
                </pre>
              </div>
            )}

            {selectedEvent.rawData && (
              <div>
                <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--fg-muted)]">
                  Raw Data
                </span>
                <pre className="mt-1 rounded-[var(--radius-sm)] bg-[var(--bg-code)] border border-[var(--border)] p-3 text-[11px] font-[family-name:var(--font-mono)] text-[var(--fg-muted)] leading-[1.7] whitespace-pre-wrap break-all overflow-auto max-h-[400px]">
                  {JSON.stringify(selectedEvent.rawData, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}
      </DetailDrawer>

      {/* Error detail drawer */}
      <DetailDrawer open={!!selectedError} onClose={() => setSelectedError(null)} title="Error Detail">
        {selectedError && (
          <div className="flex flex-col gap-4">
            <div>
              <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--fg-muted)]">Type</span>
              <div className="mt-1 text-[13px] font-semibold text-[var(--failed)]">{selectedError.type}</div>
            </div>

            {(selectedError.stage || selectedError.agent) && (
              <div className="grid grid-cols-[90px_1fr] gap-y-2 gap-x-3 text-[12px]">
                {selectedError.stage && (
                  <>
                    <span className="text-[var(--fg-muted)]">Stage</span>
                    <span className="font-[family-name:var(--font-mono-ui)] text-[var(--fg)]">
                      {selectedError.stage}
                    </span>
                  </>
                )}
                {selectedError.agent && (
                  <>
                    <span className="text-[var(--fg-muted)]">Agent</span>
                    <span className="font-[family-name:var(--font-mono-ui)] text-[var(--fg)]">
                      {selectedError.agent}
                    </span>
                  </>
                )}
                {selectedError.timestamp && (
                  <>
                    <span className="text-[var(--fg-muted)]">Time</span>
                    <span className="font-[family-name:var(--font-mono-ui)] text-[var(--fg)]">
                      {selectedError.timestamp}
                    </span>
                  </>
                )}
              </div>
            )}

            {selectedError.detail && (
              <div>
                <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--fg-muted)]">
                  Error Message
                </span>
                <pre className="mt-1 rounded-[var(--radius-sm)] bg-[var(--bg-code)] border border-[var(--border)] p-3 text-[11px] font-[family-name:var(--font-mono)] text-[var(--fg-muted)] leading-[1.7] whitespace-pre-wrap break-words overflow-auto max-h-[400px]">
                  {selectedError.detail}
                </pre>
              </div>
            )}
          </div>
        )}
      </DetailDrawer>
    </div>
  );
}
