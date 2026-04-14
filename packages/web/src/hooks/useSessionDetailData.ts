/**
 * Web session detail data fetcher.
 *
 * Mirrors packages/tui/hooks/useSessionDetailData.ts -- consolidates the
 * fetching effects for session detail, todos, messages, flow stages,
 * cost, and the running-output poller. Returns the live state plus
 * setters needed by the parent component for optimistic updates.
 */

import { useState, useEffect, useRef } from "react";
import { api } from "./useApi.js";

export interface SessionCostTotals {
  cost: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
}

export interface SessionDetailData {
  detail: any;
  setDetail: (d: any) => void;
  todos: any[];
  setTodos: (t: any[]) => void;
  messages: any[];
  flowStages: any[];
  cost: SessionCostTotals | null;
  output: string;
  outputRef: React.RefObject<HTMLDivElement | null>;
}

export function useSessionDetailData(sessionId: string): SessionDetailData {
  const [detail, setDetail] = useState<any>(null);
  const [todos, setTodos] = useState<any[]>([]);
  const [messages, setMessages] = useState<any[]>([]);
  const [flowStages, setFlowStages] = useState<any[]>([]);
  const [cost, setCost] = useState<SessionCostTotals | null>(null);
  const [output, setOutput] = useState("");
  const outputRef = useRef<HTMLDivElement>(null);

  // Detail
  useEffect(() => {
    if (!sessionId) return;
    api.getSession(sessionId).then(setDetail);
  }, [sessionId]);

  // Todos
  useEffect(() => {
    if (!sessionId) return;
    api.getTodos(sessionId).then((data) => setTodos(Array.isArray(data) ? data : [])).catch(() => {});
  }, [sessionId]);

  // Messages (conversation history)
  useEffect(() => {
    if (!sessionId) return;
    api.getMessages(sessionId)
      .then((data) => setMessages(Array.isArray(data?.messages) ? data.messages : Array.isArray(data) ? data : []))
      .catch(() => {});
  }, [sessionId]);

  // Cost from usage_records
  useEffect(() => {
    if (!sessionId) { setCost(null); return; }
    api.getSessionCost(sessionId).then(setCost).catch(() => setCost(null));
  }, [sessionId, detail?.session?.updated_at]);

  // Flow stages (pipeline visualization)
  useEffect(() => {
    if (!detail?.session?.flow) { setFlowStages([]); return; }
    api.getFlowDetail(detail.session.flow)
      .then((d: any) => setFlowStages(d.stages || []))
      .catch(() => setFlowStages([]));
  }, [detail?.session?.flow]);

  // Poll session detail while in an active state
  useEffect(() => {
    if (!sessionId || !detail?.session) return;
    const status = detail.session.status;
    const ACTIVE = ["running", "waiting", "blocked", "pending", "ready"];
    if (!ACTIVE.includes(status)) return;

    let active = true;
    const poll = () => {
      if (!active) return;
      api.getSession(sessionId).then(d => { if (active) setDetail(d); });
      api.getTodos(sessionId).then(d => { if (active) setTodos(Array.isArray(d) ? d : []); }).catch(() => {});
      api.getMessages(sessionId)
        .then(d => { if (active) setMessages(Array.isArray(d?.messages) ? d.messages : Array.isArray(d) ? d : []); })
        .catch(() => {});
      api.getSessionCost(sessionId).then(d => { if (active) setCost(d); }).catch(() => setCost(null));
    };

    const iv = setInterval(poll, 5000);
    return () => { active = false; clearInterval(iv); };
  }, [sessionId, detail?.session?.status]);

  // Poll output for running sessions
  useEffect(() => {
    if (!detail || !detail.session) return;
    if (detail.session.status !== "running" && detail.session.status !== "waiting") return;
    let active = true;
    function poll() {
      if (!active) return;
      api.getOutput(sessionId)
        .then((d) => { if (active && d.output) setOutput(d.output); })
        .catch(() => {});
    }
    poll();
    const iv = setInterval(poll, 2000);
    return () => { active = false; clearInterval(iv); };
  }, [detail?.session?.status, sessionId]);

  // Auto-scroll output
  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [output]);

  return { detail, setDetail, todos, setTodos, messages, flowStages, cost, output, outputRef };
}
