/**
 * useSessionStream
 *
 * Single custom hook that owns all the server state a session detail view
 * needs: session record, todos, messages, flow stages, cost, and live /
 * recorded terminal output.
 *
 * Replaces the prior `useSessionDetailData`, which was a 7-useEffect god hook
 * with two manually-managed polling intervals and bespoke "am I still
 * mounted?" flags. Everything here is a TanStack Query, so:
 *
 *   - cancellation is automatic (queries clean up when the component
 *     unmounts or `sessionId` changes);
 *   - polling is driven by `refetchInterval` -- TanStack pauses in background
 *     tabs by default;
 *   - the query cache de-duplicates concurrent requests for the same key;
 *   - consumers can call `queryClient.invalidateQueries({ queryKey: ["session", id] })`
 *     after optimistic actions instead of wiring up local setters.
 *
 * Polling cadences are preserved from the old implementation so behaviour is
 * unchanged:
 *   - session/todos/messages/cost: 5s while active, otherwise not polled
 *   - terminal output: 2s while running, then a single recording fetch on
 *     terminal states (completed/stopped/failed).
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { useApi } from "./useApi.js";

const ACTIVE_STATES = new Set(["running", "waiting", "blocked", "pending", "ready"]);
const TERMINAL_STATES = new Set(["completed", "stopped", "failed", "killed"]);
const RUNNING_STATES = new Set(["running", "waiting"]);

export interface SessionCostTotals {
  cost: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
}

export interface SessionStream {
  detail: any;
  todos: any[];
  messages: any[];
  flowStages: any[];
  cost: SessionCostTotals | null;
  output: string;
  outputRef: React.RefObject<HTMLDivElement | null>;
  setTodos: (next: any[]) => void;
  /** Force a fresh fetch of the session record (e.g. after a stop/restart). */
  refetchDetail: () => void;
}

export function useSessionStream(sessionId: string): SessionStream {
  const api = useApi();
  const qc = useQueryClient();
  const outputRef = useRef<HTMLDivElement>(null);

  const detailQuery = useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => api.getSession(sessionId),
    enabled: !!sessionId,
    refetchInterval: (q) => {
      const status = (q.state.data as any)?.session?.status;
      return ACTIVE_STATES.has(status) ? 5000 : false;
    },
  });
  const status: string | undefined = detailQuery.data?.session?.status;
  const flowName: string | undefined = detailQuery.data?.session?.flow;
  const isActive = !!status && ACTIVE_STATES.has(status);
  const isRunning = !!status && RUNNING_STATES.has(status);
  const isTerminal = !!status && TERMINAL_STATES.has(status);

  const todosQuery = useQuery({
    queryKey: ["session", sessionId, "todos"],
    queryFn: () => api.getTodos(sessionId).then((d) => (Array.isArray(d) ? d : [])),
    enabled: !!sessionId,
    refetchInterval: isActive ? 5000 : false,
  });

  const messagesQuery = useQuery({
    queryKey: ["session", sessionId, "messages"],
    queryFn: () =>
      api
        .getMessages(sessionId)
        .then((data: any) => (Array.isArray(data?.messages) ? data.messages : Array.isArray(data) ? data : [])),
    enabled: !!sessionId,
    refetchInterval: isActive ? 5000 : false,
  });

  const costQuery = useQuery<SessionCostTotals | null>({
    queryKey: ["session", sessionId, "cost", detailQuery.data?.session?.updated_at ?? null],
    queryFn: () =>
      api.getSessionCost(sessionId).catch((err) => {
        // Cost endpoint can 404 while a brand-new session has no usage rows
        // yet; keep the null sentinel but surface unexpected failures.
        console.warn(
          `useSessionStream: getSessionCost failed (sessionId=${sessionId}):`,
          err instanceof Error ? err.message : err,
        );
        return null;
      }),
    enabled: !!sessionId,
    refetchInterval: isActive ? 5000 : false,
  });

  const flowStagesQuery = useQuery({
    queryKey: ["flow", flowName ?? "__none__", "stages"],
    queryFn: () => api.getFlowDetail(flowName!).then((d: any) => d.stages || []),
    enabled: !!flowName,
  });

  const outputQuery = useQuery<string>({
    queryKey: ["session", sessionId, "output"],
    queryFn: async () => {
      if (isRunning) {
        const res = await api.getOutput(sessionId);
        return res.output || "";
      }
      if (isTerminal) {
        const res = await api.getRecording(sessionId);
        return res.ok && res.output ? res.output : "";
      }
      return "";
    },
    enabled: !!sessionId && (isRunning || isTerminal),
    refetchInterval: isRunning ? 2000 : false,
  });

  // Auto-scroll terminal output. Pure DOM side effect, not part of render.
  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [outputQuery.data]);

  const setTodos = useCallback(
    (next: any[]) => qc.setQueryData(["session", sessionId, "todos"], next),
    [qc, sessionId],
  );

  const refetchDetail = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["session", sessionId] });
  }, [qc, sessionId]);

  return {
    detail: detailQuery.data ?? null,
    todos: todosQuery.data ?? [],
    messages: messagesQuery.data ?? [],
    flowStages: flowStagesQuery.data ?? [],
    cost: costQuery.data ?? null,
    output: outputQuery.data ?? "",
    outputRef,
    setTodos,
    refetchDetail,
  };
}
