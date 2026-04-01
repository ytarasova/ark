/**
 * Centralized message state management.
 *
 * Owns all message operations: store, send, deliver, poll.
 * Both Chat (1:1) and Threads (multi-session) consume this hook.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import * as core from "../../core/index.js";

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

interface UseMessagesOpts {
  sessionId?: string | null;
  sessions?: core.Session[];
  pollMs?: number;
  limit?: number;
}

interface UseMessagesResult {
  messages: ThreadMessage[];
  send: (targetSessionId: string, content: string) => void;
  sending: boolean;
  error: string | null;
}

export function useMessages(opts: UseMessagesOpts): UseMessagesResult {
  const { sessionId, sessions, pollMs = 2000, limit = 30 } = opts;
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Use refs for values that change frequently but shouldn't reset the poll interval
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const limitRef = useRef(limit);
  limitRef.current = limit;

  const loadMessages = useCallback(() => {
    const currentLimit = limitRef.current;
    if (sessionId) {
      const msgs = core.getMessages(sessionId, { limit: currentLimit });
      setMessages(msgs.map(m => ({
        ...m,
        sessionName: "",
        time: m.created_at.slice(11, 16),
      })));
    } else if (sessionsRef.current?.length) {
      const all: ThreadMessage[] = [];
      for (const s of sessionsRef.current) {
        const msgs = core.getMessages(s.id, { limit: currentLimit });
        const name = s.summary ?? s.id.slice(0, 8);
        for (const m of msgs) {
          all.push({ ...m, sessionName: name, time: m.created_at.slice(11, 16) });
        }
      }
      all.sort((a, b) => a.id - b.id);
      setMessages(all.slice(-currentLimit));
    }
  }, [sessionId]);

  useEffect(() => {
    loadMessages();
    const t = setInterval(loadMessages, pollMs);
    return () => clearInterval(t);
  }, [loadMessages, pollMs]);

  const send = useCallback((targetSessionId: string, content: string) => {
    core.addMessage({ session_id: targetSessionId, role: "user", content });
    loadMessages();
    core.markMessagesRead(targetSessionId);

    setSending(true);
    setError(null);
    const channelPort = core.sessionChannelPort(targetSessionId);
    fetch(`http://localhost:${channelPort}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "steer",
        sessionId: targetSessionId,
        message: content,
        from: "user",
      }),
    })
      .then(() => { setSending(false); })
      .catch(() => {
        core.addMessage({
          session_id: targetSessionId,
          role: "system",
          content: `Failed to deliver (port ${channelPort})`,
          type: "error",
        });
        loadMessages();
        setSending(false);
        setError(`Failed to deliver to port ${channelPort}`);
      });
  }, [loadMessages]);

  return { messages, send, sending, error };
}
