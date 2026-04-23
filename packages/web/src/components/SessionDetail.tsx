import { useState } from "react";
import { useApi } from "../hooks/useApi.js";
import { useSessionDetail } from "../hooks/useSessionDetail.js";
import { useSessionActions } from "../hooks/useSessionActions.js";
import { fmtCost } from "../util.js";

import { SessionHeader } from "./ui/SessionHeader.js";
import { ContentTabs } from "./ui/ContentTabs.js";
import { ChatInput } from "./ui/ChatInput.js";
import { ScrollProgress } from "./ui/ScrollProgress.js";
import { type TimelineEvent } from "./ui/EventTimeline.js";
import { ConfirmDialog } from "./ui/ConfirmDialog.js";

import { normalizeStatus } from "./session/timeline-builder.js";
import { HeaderActions } from "./session/HeaderActions.js";
import { StageProgress } from "./session/StageProgress.js";
import { EventDetailDrawer } from "./session/EventDetailDrawer.js";
import { ErrorDetailDrawer } from "./session/ErrorDetailDrawer.js";
import { EventsFooter, DiffFooter, TodosFooter } from "./session/TabFooter.js";
import { TabPanels } from "./session/TabPanels.js";
import { RejectGateModal } from "./session/RejectGateModal.js";
import { RestartDialog } from "./session/RestartDialog.js";
import type { ErrorInfo } from "./session/types.js";

// Re-exported for back-compat: `__tests__/RejectGateModal.test.ts` imports
// the modal from this module; keep the symbol here so that import path holds.
export { RejectGateModal } from "./session/RejectGateModal.js";

interface SessionDetailProps {
  sessionId: string;
  onToast: (msg: string, type: string) => void;
  readOnly: boolean;
  initialTab?: string | null;
  onTabChange?: (tab: string | null) => void;
}

export function SessionDetail({ sessionId, onToast, readOnly, initialTab, onTabChange }: SessionDetailProps) {
  const api = useApi();
  const d = useSessionDetail({ sessionId, initialTab, onTabChange });
  const { actionLoading, handleAction, handleGateApprove, handleGateReject, handleRestart } = useSessionActions({
    sessionId,
    onToast,
    refetchDetail: d.refetchDetail,
  });

  const [chatMsg, setChatMsg] = useState("");
  const [activeDiffFile, setActiveDiffFile] = useState<string | undefined>(undefined);
  const [selectedEvent, setSelectedEvent] = useState<TimelineEvent | null>(null);
  const [selectedError, setSelectedError] = useState<ErrorInfo | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [restartDialogOpen, setRestartDialogOpen] = useState(false);

  if (!d.session) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-[var(--fg-muted)]">Loading session...</div>
    );
  }
  const { session, events, todos, setTodos } = d;
  const canShowGate = d.isReviewGate && !readOnly;

  const handleSend = async (attachments?: { name: string; dataUrl: string }[]) => {
    let content = chatMsg.trim();
    if (attachments && attachments.length > 0) {
      const imageRefs = attachments.map((a) => `\n[image: ${a.name}]\n${a.dataUrl}`).join("\n");
      content = content ? content + imageRefs : imageRefs.trim();
    }
    if (!content) return;
    setChatMsg("");
    const res = await d.send(content);
    if (res.ok === false)
      onToast(`Send to ${sessionId} failed: ${res.message || "session may not be running"}`, "error");
  };

  const handleToggleTodo = async (id: number) => {
    try {
      const res = await api.toggleTodo(id);
      if (res.ok !== false && res.todo) setTodos(todos.map((t) => (t.id === id ? res.todo : t)));
    } catch (err: any) {
      onToast(`Failed to toggle todo: ${err.message || "network error"}`, "error");
    }
  };

  const submitReject = async () => {
    const ok = await handleGateReject(rejectReason);
    if (ok) {
      setRejectOpen(false);
      setRejectReason("");
    }
  };

  const headerActions = (
    <HeaderActions
      status={session.status}
      isActive={d.isActive}
      canShowGate={canShowGate}
      actionLoading={actionLoading}
      onAction={handleAction}
      onDelete={() => setDeleteConfirmOpen(true)}
      onApprove={handleGateApprove}
      onOpenReject={() => setRejectOpen(true)}
      onOpenRestart={() => setRestartDialogOpen(true)}
    />
  );

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-[var(--bg)]">
      <ScrollProgress progress={d.scrollProgress} />
      <SessionHeader
        sessionId={session.id}
        summary={session.summary || session.id}
        status={normalizeStatus(session.status)}
        stages={d.stages}
        cost={d.cost?.cost ? fmtCost(d.cost.cost) : undefined}
        actions={!readOnly ? headerActions : undefined}
        onCopyId={() => {
          navigator.clipboard.writeText(session.id);
          onToast("Copied session ID", "success");
        }}
        selectedStage={d.stageFilter}
        onStageClick={d.toggleStageFilter}
      />

      {d.totalStages > 0 && (
        <StageProgress
          agent={session.agent}
          flow={session.flow}
          completedStages={d.completedStages}
          totalStages={d.totalStages}
          progressPct={d.progressPct}
        />
      )}

      <ContentTabs tabs={d.tabs} activeTab={d.activeTab} onTabChange={d.setActiveTab} ariaLabel="Session detail tabs" />

      <TabPanels
        activeTab={d.activeTab}
        scrollRef={d.scrollRef}
        onScroll={d.handleScroll}
        session={session}
        timeline={d.timeline}
        conversationMessages={d.conversationMessages}
        events={events}
        cost={d.cost}
        isActive={d.isActive}
        agentIsTyping={d.agentIsTyping}
        bottomRef={d.bottomRef}
        output={d.output}
        timelineEvents={d.timelineEvents}
        onStageFilterToggle={(stage) => {
          d.toggleStageFilter(stage);
          d.setActiveTab("conversation");
        }}
        onEventSelect={setSelectedEvent}
        diffData={d.diffData}
        diffFiles={d.diffFiles}
        activeDiffFile={activeDiffFile}
        onDiffFileSelect={setActiveDiffFile}
        todoItems={d.todoItems}
        onToggleTodo={handleToggleTodo}
        errorEvents={d.errorEvents}
        onSelectError={setSelectedError}
      />

      {d.activeTab === "conversation" && (
        <ChatInput
          value={chatMsg}
          onChange={setChatMsg}
          onSend={handleSend}
          disabled={!d.isActive || d.sending}
          disabledText={!d.isActive ? "Session is not running" : undefined}
          modelName={session.config?.model || session.agent}
        />
      )}

      {d.activeTab === "events" && events.length > 0 && (
        <EventsFooter events={events} sessionId={session.id} onToast={onToast} />
      )}
      {d.activeTab === "diff" && d.diffData && <DiffFooter diffData={d.diffData} />}
      {d.activeTab === "todos" && todos.length > 0 && <TodosFooter todos={todos} />}

      <EventDetailDrawer event={selectedEvent} onClose={() => setSelectedEvent(null)} />
      <ErrorDetailDrawer error={selectedError} onClose={() => setSelectedError(null)} />

      {rejectOpen && (
        <RejectGateModal
          reason={rejectReason}
          submitting={actionLoading === "reject"}
          onReasonChange={setRejectReason}
          onCancel={() => {
            setRejectOpen(false);
            setRejectReason("");
          }}
          onSubmit={submitReject}
        />
      )}
      <ConfirmDialog
        open={deleteConfirmOpen}
        onClose={() => setDeleteConfirmOpen(false)}
        onConfirm={async () => {
          setDeleteConfirmOpen(false);
          await handleAction("delete");
        }}
        title="Delete session?"
        message={`This removes events, worktree, and tmux state for ${sessionId}. This cannot be undone.`}
        confirmLabel="Delete"
        danger
        loading={actionLoading === "delete"}
      />
      <RestartDialog
        sessionId={sessionId}
        open={restartDialogOpen}
        onClose={() => setRestartDialogOpen(false)}
        onRestart={async (rewindToStage) => {
          await handleRestart(rewindToStage);
          setRestartDialogOpen(false);
        }}
      />
    </div>
  );
}
