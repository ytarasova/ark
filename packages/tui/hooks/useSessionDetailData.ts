/**
 * Session detail data fetcher.
 *
 * Consolidates the side-effect-heavy pieces of SessionDetail (events,
 * conversation, todos, cost, flow stages) so the component itself can
 * stay focused on rendering and keyboard handling. Each piece refreshes
 * automatically when the session id (or its `updated_at`) changes.
 */

import { useState, useEffect, useCallback } from "react";
import type { Session, Event } from "../../core/index.js";
import type { StageDefinition } from "../../core/state/flow.js";
import { useArkClient } from "./useArkClient.js";

export interface SessionCostTotals {
  cost: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
}

export interface SessionDetailData {
  events: Event[];
  conversation: { role: string; content: string; timestamp: string }[];
  todos: any[];
  cost: SessionCostTotals | null;
  flowStages: StageDefinition[];
  /** Manually re-fetch todos. */
  refreshTodos: () => void;
}

export function useSessionDetailData(s: Session | null, onTodoChange?: () => void): SessionDetailData {
  const ark = useArkClient();
  const [events, setEvents] = useState<Event[]>([]);
  const [conversation, setConversation] = useState<{ role: string; content: string; timestamp: string }[]>([]);
  const [todos, setTodos] = useState<any[]>([]);
  const [cost, setCost] = useState<SessionCostTotals | null>(null);
  const [flowStages, setFlowStages] = useState<StageDefinition[]>([]);

  // Events
  useEffect(() => {
    if (!s) { setEvents([]); return; }
    ark.sessionEvents(s.id, 50).then(setEvents).catch(() => setEvents([]));
  }, [s?.id, s?.status]);

  // Todos
  useEffect(() => {
    if (!s) { setTodos([]); return; }
    ark.todoList(s.id).then(r => setTodos(r.todos ?? [])).catch(() => setTodos([]));
  }, [s?.id, s?.status]);

  const refreshTodos = useCallback(() => {
    if (!s) return;
    ark.todoList(s.id).then(r => setTodos(r.todos ?? [])).catch(() => {});
    onTodoChange?.();
  }, [s?.id, onTodoChange]);

  // Conversation: only for sessions with a local Claude transcript
  useEffect(() => {
    if (!s) { setConversation([]); return; }
    if (!s.claude_session_id) { setConversation([]); return; }
    ark.sessionConversation(s.claude_session_id, 100).then(setConversation).catch(() => setConversation([]));
  }, [s?.id, s?.claude_session_id, s?.status]);

  // Cost from usage_records
  useEffect(() => {
    if (!s) { setCost(null); return; }
    ark.costsSession(s.id).then(r => setCost({
      cost: r.cost,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      cache_read_tokens: r.cache_read_tokens,
      total_tokens: r.total_tokens,
    })).catch(() => setCost(null));
  }, [s?.id, s?.updated_at]);

  // Flow stages from RPC (remote-capable)
  useEffect(() => {
    if (!s?.flow) { setFlowStages([]); return; }
    ark.flowRead(s.flow).then(f => setFlowStages(f.stages ?? [])).catch(() => setFlowStages([]));
  }, [s?.flow]);

  return { events, conversation, todos, cost, flowStages, refreshTodos };
}
