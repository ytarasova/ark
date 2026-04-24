import { useState } from "react";
import { api } from "../hooks/useApi.js";
import { useSessionDetail } from "../hooks/useSessionDetail.js";
import { useSessionActions } from "../hooks/useSessionActions.js";
import { useModelsQuery } from "../hooks/useRuntimeQueries.js";
import { fmtCost, fmtTokens } from "../util.js";

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
import { BudgetBar } from "./session/BudgetBar.js";
import { ResumeBanner } from "./session/ResumeBanner.js";
import { ForEachRollup, ChildSessionCluster } from "./session/ForEachRollup.js";
import { SessionBreadcrumb } from "./session/SessionBreadcrumb.js";
import type { ErrorInfo } from "./session/types.js";

// Re-exported for back-compat: `__tests__/RejectGateModal.test.ts` imports
// the modal from this module; keep the symbol here so that import path holds.
export { RejectGateModal } from "./session/RejectGateModal.js";

/**
 * Build the right-side ticker values for the 44px header strip:
 *   `150K TOK   $0.84   02:47`
 *
 * The ticker always renders (even when cost is 0) so the strip stays
 * visually balanced. Values fall back to a dash when we have no data.
 */
function buildHeaderTickers(session: any, cost: any): { label: string; value: string; bump?: boolean }[] {
  const tokensIn = cost?.tokens_in;
  const tokensOut = cost?.tokens_out;
  const tokStr = fmtTokens(tokensIn, tokensOut);
  const spendStr = cost?.cost != null ? fmtCost(cost.cost) : "$0.00";

  const startMs = Date.parse(session.started_at || session.created_at || "");
  const endMs = session.status === "running" ? Date.now() : Date.parse(session.ended_at || session.updated_at || "");
  let elapsed = "--:--";
  if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
    const secs = Math.floor((endMs - startMs) / 1000);
    const hh = Math.floor(secs / 3600);
    const mm = Math.floor((secs % 3600) / 60);
    const ss = secs % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    elapsed = hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
  }

  return [
    { label: "tok", value: tokStr || "0", bump: true },
    { label: "", value: spendStr, bump: true },
    { label: "", value: elapsed, bump: session.status === "running" },
  ];
}

interface SessionDetailProps {
  sessionId: string;
  onToast: (msg: string, type: string) => void;
  readOnly: boolean;
  initialTab?: string | null;
  onTabChange?: (tab: string | null) => void;
}

export function SessionDetail({ sessionId, onToast, readOnly, initialTab, onTabChange }: SessionDetailProps) {
  const d = useSessionDetail({ sessionId, initialTab, onTabChange });
  const { actionLoading, handleAction, handleGateApprove, handleGateReject, handleRestart } = useSessionActions({
    sessionId,
    onToast,
    refetchDetail: d.refetchDetail,
  });
  // The model catalog is needed to resolve an inline agent's model id to its
  // human-readable display name in the header. The query is cached, so this
  // is a no-op on subsequent renders.
  const { data: models } = useModelsQuery();

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
      {session.parent_id && <SessionBreadcrumb session={session} />}
      <SessionHeader
        sessionId={session.id}
        summary={session.summary || session.id}
        status={normalizeStatus(session.status)}
        stageLabel={session.stage ? `${session.status} · ${session.stage}` : undefined}
        runtime={session.runtime || session.agent_runtime}
        agent={session.agent}
        compute={session.compute_provider || session.compute_kind}
        kvs={
          [
            session.branch ? { k: "branch", v: session.branch, mono: true } : null,
            session.flow ? { k: "flow", v: session.flow } : null,
          ].filter(Boolean) as any
        }
        session={session}
        models={models}
        tickers={buildHeaderTickers(session, d.cost)}
        cost={d.cost?.cost ? fmtCost(d.cost.cost) : undefined}
        actions={!readOnly ? headerActions : undefined}
        onCopyId={() => {
          navigator.clipboard.writeText(session.id);
          onToast("Copied session ID", "success");
        }}
        selectedStage={d.stageFilter}
        onStageClick={d.toggleStageFilter}
        stages={d.stages}
      />

      {d.totalStages > 0 && (
        <StageProgress completedStages={d.completedStages} totalStages={d.totalStages} progressPct={d.progressPct} />
      )}

      {/* Phase 3: resume-from-checkpoint banner. Surfaces when the session
          has a stored for_each_checkpoint and isn't running. */}
      {session.config?.for_each_checkpoint && session.status !== "running" && (
        <ResumeBanner checkpoint={`iteration ${session.config.for_each_checkpoint.index ?? "?"}`} />
      )}

      {/* Phase 3: per-session budget cap bar. Suppressed unless the session
          has a budget cap AND we're at >= 50% utilisation -- below that the
          row is just visual noise (the Cost tab still surfaces the detail).
          See Nit 2 in the cost-redundancy cleanup. */}
      {session.config?.max_budget_usd && (d.cost?.cost ?? 0) / session.config.max_budget_usd >= 0.5 && (
        <div className="px-[18px] py-[8px] border-b border-[var(--border-light)] bg-[rgba(0,0,0,0.12)]">
          <BudgetBar spent={d.cost?.cost ?? 0} cap={session.config.max_budget_usd} />
        </div>
      )}

      <ContentTabs tabs={d.tabs} activeTab={d.activeTab} onTabChange={d.setActiveTab} ariaLabel="Session detail tabs" />

      {/* Phase 2: for_each rollup + child cluster. Rendered inline above the
          tab body so they're visible on every tab. Data is expected on
          session.config.for_each. */}
      {(session.config?.for_each?.total || session.children?.length > 0) && (
        <div className="px-[18px] pt-[10px] pb-[4px] grid grid-cols-1 lg:grid-cols-2 gap-[10px] shrink-0">
          {session.config?.for_each?.total && (
            <ForEachRollup
              total={session.config.for_each.total}
              completed={session.config.for_each.completed ?? 0}
              failed={session.config.for_each.failed ?? 0}
              inflight={session.config.for_each.inflight ?? 0}
              iterations={session.config.for_each.iterations ?? []}
              onOpenIteration={(id) => {
                window.location.hash = `#/sessions/${id}`;
              }}
            />
          )}
          {session.children && session.children.length > 0 && (
            <ChildSessionCluster
              parentId={session.parent_id}
              children={session.children}
              onOpen={(id) => {
                window.location.hash = `#/sessions/${id}`;
              }}
            />
          )}
        </div>
      )}

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
        stages={d.stages}
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
