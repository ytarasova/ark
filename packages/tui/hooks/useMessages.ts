/**
 * Centralized message state management.
 *
 * Owns all message operations: store, send, deliver, poll.
 * Both Chat (1:1) and Threads (multi-session) consume this hook.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useArkClient } from "./useArkClient.js";
import type { AsyncState } from "./useAsync.js";

export interface ThreadMessage {
  id: number;
  session_id: string;
  role: string;
  content: string;
  type: string;
  created_at: string;
  read: boolean;
  sessionName: string;
  time: string;
}

interface SessionLike {
  id: string;
  summary?: string | null;
}

interface UseMessagesOpts {
  sessionId?: string | null;
  sessions?: SessionLike[];
  pollMs?: number;
  limit?: number;
  asyncState?: AsyncState;
}

interface UseMessagesResult {
  messages: ThreadMessage[];
  send: (targetSessionId: string, content: string) => void;
  sending: boolean;
  error: string | null;
}

export function useMessages(opts: UseMessagesOpts): UseMessagesResult {
  const { sessionId, sessions, pollMs = 2000, limit = 30, asyncState } = opts;
  const ark = useArkClient();
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Use refs for values that change frequently but shouldn't reset the poll interval
  const sessionIdRef = useRef(sessionId);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const limitRef = useRef(limit);
  limitRef.current = limit;

  const loadMessages = useCallback(async () => {
    const currentLimit = limitRef.current;
    const currentSessionId = sessionIdRef.current;
    if (currentSessionId) {
      const msgs = await ark.sessionMessages(currentSessionId, currentLimit);
      setMessages(msgs.map((m: any) => ({
        ...m,
        sessionName: "",
        time: m.created_at?.slice(11, 16) ?? "",
      })));
    } else if (sessionsRef.current?.length) {
      const all: ThreadMessage[] = [];
      for (const s of sessionsRef.current) {
        const msgs = await ark.sessionMessages(s.id, currentLimit);
        const name = s.summary ?? s.id.slice(0, 8);
        for (const m of msgs) {
          all.push({ ...m, sessionName: name, time: m.created_at?.slice(11, 16) ?? "" });
        }
      }
      all.sort((a, b) => a.id - b.id);
      setMessages(all.slice(-currentLimit));
    }
  }, [ark]);

  // Reload immediately when sessionId changes
  useEffect(() => {
    loadMessages();
  }, [sessionId]);

  useEffect(() => {
    const t = setInterval(loadMessages, pollMs);
    return () => clearInterval(t);
  }, [loadMessages, pollMs]);

  const send = useCallback((targetSessionId: string, content: string) => {
    const doSend = async () => {
      setSending(true);
      setError(null);
      try {
        await ark.messageSend(targetSessionId, content);
        await ark.messageMarkRead(targetSessionId);
        await loadMessages();
        setSending(false);
      } catch (e: any) {
        setSending(false);
        setError(`Failed to deliver: ${e?.message ?? e}`);
        await loadMessages();
      }
    };

    if (asyncState) {
      asyncState.run("Sending...", doSend);
    } else {
      doSend();
    }
  }, [ark, loadMessages, asyncState]);

  return { messages, send, sending, error };
}
