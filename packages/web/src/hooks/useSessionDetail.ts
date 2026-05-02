import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useApi } from "./useApi.js";
import { useSessionStream } from "./useSessionStream.js";
import { useMessages } from "./useMessages.js";
import {
  buildStageProgress,
  parseUnifiedDiff,
  buildConversationTimeline,
} from "../components/session/timeline-builder.js";
import type { DiffFile } from "../components/ui/DiffViewer.js";
import type { TodoItem } from "../components/ui/TodoList.js";
import type { TabDef } from "../components/ui/ContentTabs.js";

// "knowledge" is still a valid hash-router target so deep links survive,
// but it no longer gets top-level tab strip real estate (low-frequency,
// low-density panel; reachable via direct URL only).
const VALID_TABS = new Set([
  "conversation",
  "logs",
  "terminal",
  "diff",
  "cost",
  "todos",
  "errors",
  "flow",
  "knowledge",
]);

/**
 * Bundles all of the server state + derived data + view-local state that
 * `SessionDetail` needs, so the view component can stay a thin composition
 * over the returned values.
 *
 * Owns:
 * - server state via `useSessionStream` + `useMessages` + a lazy diff query
 * - view state (active tab, stage filter, scroll progress, scroll refs)
 * - derived data (stages, conversation timeline, todos, diff files, tab list)
 */
export function useSessionDetail({
  sessionId,
  initialTab,
  onTabChange,
}: {
  sessionId: string;
  initialTab?: string | null;
  onTabChange?: (tab: string | null) => void;
}) {
  const api = useApi();
  const {
    detail,
    todos,
    setTodos,
    messages: detailMessages,
    flowStages,
    cost,
    output,
    refetchDetail,
  } = useSessionStream(sessionId);

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

  const [scrollProgress, setScrollProgress] = useState(0);
  const [stageFilter, setStageFilter] = useState<string | null>(null);
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

  // Show typing indicator only when agent has recent hook activity (last 10s).
  const lastHookTime = events
    .filter((ev: any) => ev.type === "hook_status")
    .reduce((latest: number, ev: any) => Math.max(latest, new Date(ev.created_at).getTime()), 0);
  const agentIsTyping = isActive && lastHookTime > 0 && Date.now() - lastHookTime < 10_000;

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    setScrollProgress(max > 0 ? (el.scrollTop / max) * 100 : 0);
  }, []);

  // Auto-scroll to bottom when new messages arrive while active + conversation tab open.
  useEffect(() => {
    const count = conversationMessages.length;
    const prev = prevMsgCountRef.current;
    prevMsgCountRef.current = count;
    if (prev === null || prev === count) return;
    if (bottomRef.current && activeTab === "conversation" && isActive) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [conversationMessages.length, activeTab, isActive]);

  // Diff is only fetched when the user opens the Diff tab. TanStack Query
  // caches per sessionId so switching tabs does not re-fetch.
  const { data: diffData } = useQuery({
    queryKey: ["session", sessionId, "diff"],
    queryFn: () => api.worktreeDiff(sessionId),
    enabled: !!sessionId && activeTab === "diff",
  });

  const toggleStageFilter = useCallback(
    (stage: string) => setStageFilter((prev) => (prev === stage ? null : stage)),
    [],
  );

  const errorEvents = events.filter(
    (ev: any) =>
      ev.type === "error" ||
      ev.type === "action_failed" ||
      ev.type === "dispatch_failed" ||
      (ev.data?.error && ev.type !== "hook_status"),
  );
  const hasErrors = session?.status === "failed" || errorEvents.length > 0;

  const stages = session ? buildStageProgress(session, flowStages) : [];
  const completedStages = stages.filter((s) => s.state === "done").length;
  const totalStages = stages.length;
  const progressPct = totalStages > 0 ? Math.round((completedStages / totalStages) * 100) : 0;

  // Count conversation messages (user + agent) for the Conversation tab pill.
  const conversationCount = timeline.filter(
    (t: any) => t.kind === "user" || t.kind === "agent" || t.kind === "tool",
  ).length;
  const filesChanged = diffData?.filesChanged ?? 0;

  // Top-level tabs (+ optional Errors). Knowledge is URL-only -- it's a
  // low-frequency, low-density panel that doesn't earn top-level real estate.
  // Timeline (formerly "Conversation") absorbs the old Events tab: the
  // conversation builder already surfaces every stage/tool/action event the
  // Events tab rendered raw, so keeping both was pure duplication. Each row
  // in the Timeline view is clickable to open the raw event in a drawer.
  const tabs: TabDef[] = [
    { id: "conversation", label: "Session", badge: conversationCount > 0 ? conversationCount : undefined },
    { id: "flow", label: "Flow", badge: totalStages > 0 ? `${completedStages}/${totalStages}` : undefined },
    {
      id: "diff",
      label: "Files",
      badge:
        filesChanged > 0 ? `${filesChanged} · +${diffData?.insertions || 0} -${diffData?.deletions || 0}` : undefined,
    },
    { id: "logs", label: "Logs" },
    { id: "terminal", label: "Terminal" },
    // Cost tab carries no $-amount badge -- the running spend is already
    // visible in the header ticker, and the detail lives one click away.
    // See "Nit 2 -- cost is mentioned everywhere" in the header cleanup.
    { id: "cost", label: "Cost" },
    ...(hasErrors
      ? [{ id: "errors", label: "Errors", badge: (errorEvents.length || 1) as number | string | undefined }]
      : []),
  ];

  const todoItems: TodoItem[] = todos.map((t: any) => ({
    id: String(t.id),
    text: t.content || t.text || "",
    done: !!t.done,
    priority: t.priority || undefined,
    source: t.source || undefined,
  }));
  const diffFiles: DiffFile[] = diffData?.diff ? parseUnifiedDiff(diffData.diff) : [];

  // Detect whether the current stage is a review/manual gate so the header
  // can show Approve/Reject controls.
  const currentStageDef = flowStages.find((s: any) => s?.name === session?.stage);
  const currentGate = (currentStageDef?.gate ?? null) as string | null;
  const isReviewGate = currentGate === "review" || currentGate === "manual";

  return {
    // server state
    session,
    events,
    todos,
    setTodos,
    cost,
    output,
    refetchDetail,
    // messages
    conversationMessages,
    send,
    sending,
    // derived
    isActive,
    agentIsTyping,
    timeline,
    todoItems,
    diffData,
    diffFiles,
    stages,
    completedStages,
    totalStages,
    progressPct,
    errorEvents,
    hasErrors,
    isReviewGate,
    tabs,
    // view state
    activeTab,
    setActiveTab,
    stageFilter,
    toggleStageFilter,
    scrollRef,
    bottomRef,
    scrollProgress,
    handleScroll,
  };
}
