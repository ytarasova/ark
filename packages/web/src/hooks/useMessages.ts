import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "./useApi.js";

interface Message {
  id: number;
  session_id: string;
  role: string;
  content: string;
  type: string;
  created_at: string;
}

interface UseMessagesOpts {
  sessionId: string;
  enabled: boolean;
  pollMs?: number;
}

interface UseMessagesResult {
  messages: Message[];
  send: (content: string) => Promise<{ ok: boolean; message?: string }>;
  sending: boolean;
}

let optimisticId = -1;

export function useMessages({ sessionId, enabled, pollMs = 2000 }: UseMessagesOpts): UseMessagesResult {
  const [messages, setMessages] = useState<Message[]>([]);
  const [sending, setSending] = useState(false);
  const activeRef = useRef(true);

  const fetchMessages = useCallback(async () => {
    if (!sessionId) return;
    try {
      const data = await api.getMessages(sessionId);
      const list: Message[] = Array.isArray(data?.messages) ? data.messages : Array.isArray(data) ? data : [];
      if (activeRef.current) {
        setMessages(prev => {
          // Remove optimistic messages that now have real counterparts
          const realIds = new Set(list.map(m => m.id));
          const optimistic = prev.filter(m => m.id < 0 && !list.some(
            r => r.role === m.role && r.content === m.content &&
              Math.abs(new Date(r.created_at).getTime() - new Date(m.created_at).getTime()) < 5000
          ));
          // If we got real data, use it plus any unmatched optimistic messages
          if (list.length > 0 || optimistic.length === 0) {
            return [...list, ...optimistic];
          }
          return prev;
        });
      }
      // Mark as read
      api.markRead(sessionId).catch(() => {});
    } catch {
      // ignore fetch errors
    }
  }, [sessionId]);

  // Initial fetch and poll
  useEffect(() => {
    activeRef.current = true;
    if (!sessionId || !enabled) return;

    fetchMessages();
    const iv = setInterval(fetchMessages, pollMs);
    return () => {
      activeRef.current = false;
      clearInterval(iv);
    };
  }, [sessionId, enabled, pollMs, fetchMessages]);

  // Reset on session change
  useEffect(() => {
    setMessages([]);
  }, [sessionId]);

  const send = useCallback(async (content: string): Promise<{ ok: boolean; message?: string }> => {
    if (!content.trim() || !sessionId) return { ok: false, message: "Empty message" };

    // Optimistic add
    const tempId = optimisticId--;
    const optimistic: Message = {
      id: tempId,
      session_id: sessionId,
      role: "user",
      content,
      type: "text",
      created_at: new Date().toISOString(),
    };
    setMessages(prev => [...prev, optimistic]);

    setSending(true);
    try {
      const res = await api.send(sessionId, content);
      setSending(false);
      if (res.ok === false) {
        // Remove the optimistic message on failure
        setMessages(prev => prev.filter(m => m.id !== tempId));
        return { ok: false, message: res.message || "Send failed" };
      }
      // Trigger immediate refetch to get the real message
      fetchMessages();
      return { ok: true };
    } catch (err: any) {
      setSending(false);
      setMessages(prev => prev.filter(m => m.id !== tempId));
      return { ok: false, message: err.message || "Send failed" };
    }
  }, [sessionId, fetchMessages]);

  return { messages, send, sending };
}
