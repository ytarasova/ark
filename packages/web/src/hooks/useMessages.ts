import { useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "./useApi.js";

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
  /**
   * Poll cadence while the session is active. Kept as an option for back-compat
   * with the old hook's signature; `useSessionStream` already runs a 5s poll at
   * the same queryKey, so setting pollMs lower here just tightens the refetch
   * cadence (requests are still de-duped by the TanStack cache).
   */
  pollMs?: number;
}

interface UseMessagesResult {
  messages: Message[];
  send: (content: string) => Promise<{ ok: boolean; message?: string }>;
  sending: boolean;
  markRead: () => Promise<void>;
}

/** Tag used to distinguish an optimistic-only cache entry from a server row. */
const OPTIMISTIC_ROLE = "user";
let optimisticId = -1;

/**
 * Reads + writes for per-session message history.
 *
 * Previously this hook hand-rolled `useState + useRef + setInterval` polling
 * at 2s, while `useSessionStream` *already* polled the same endpoint at 5s via
 * TanStack Query -- meaning an active detail page fired two concurrent polls
 * against `message/list`. This rewrite collapses both into a single shared
 * queryKey (`["session", id, "messages"]`) and adds a TanStack mutation for
 * the optimistic send flow.
 *
 * The public interface (messages / send / sending) is unchanged so existing
 * call sites do not need to move. `markRead` is newly exposed but optional.
 */
export function useMessages({ sessionId, enabled, pollMs = 2000 }: UseMessagesOpts): UseMessagesResult {
  const api = useApi();
  const qc = useQueryClient();
  const queryKey = ["session", sessionId, "messages"];

  // Shared queryKey with useSessionStream. When both hooks are mounted the
  // TanStack cache de-duplicates concurrent fetches for us.
  const messagesQuery = useQuery<Message[]>({
    queryKey,
    queryFn: async () => {
      const data: any = await api.getMessages(sessionId);
      const list: Message[] = Array.isArray(data?.messages) ? data.messages : Array.isArray(data) ? data : [];
      // Best-effort markRead; failure is harmless (next tick will retry).
      api.markRead(sessionId).catch((err) => {
        console.warn(
          `useMessages: markRead failed (sessionId=${sessionId}; next poll will retry):`,
          err instanceof Error ? err.message : err,
        );
      });
      return list;
    },
    enabled: !!sessionId && enabled,
    refetchInterval: enabled ? pollMs : false,
  });

  const sendMutation = useMutation<
    { ok: boolean; message?: string },
    Error,
    string,
    { previousMessages: Message[] | undefined; tempId: number }
  >({
    mutationFn: async (content: string) => {
      const res: any = await api.send(sessionId, content);
      if (res?.ok === false) {
        // Surface the server's reason to the onError hook so we can roll back.
        throw new Error(res.message || "Send failed");
      }
      return { ok: true };
    },
    onMutate: async (content) => {
      await qc.cancelQueries({ queryKey });
      const previousMessages = qc.getQueryData<Message[]>(queryKey);
      const tempId = optimisticId--;
      const optimistic: Message = {
        id: tempId,
        session_id: sessionId,
        role: OPTIMISTIC_ROLE,
        content,
        type: "text",
        created_at: new Date().toISOString(),
      };
      qc.setQueryData<Message[]>(queryKey, (prev) => [...(prev ?? []), optimistic]);
      return { previousMessages, tempId };
    },
    onError: (_err, _content, ctx) => {
      // Restore the prior cache snapshot on failure.
      if (ctx) qc.setQueryData(queryKey, ctx.previousMessages);
    },
    onSettled: () => {
      // Refetch the real list so the server-assigned id replaces our optimistic one.
      qc.invalidateQueries({ queryKey });
    },
  });

  const send = useCallback(
    async (content: string): Promise<{ ok: boolean; message?: string }> => {
      if (!content.trim() || !sessionId) return { ok: false, message: "Empty message" };
      try {
        await sendMutation.mutateAsync(content);
        return { ok: true };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Send failed" };
      }
    },
    [sessionId, sendMutation],
  );

  const markRead = useCallback(async () => {
    try {
      await api.markRead(sessionId);
    } catch (err) {
      console.warn(`useMessages.markRead failed:`, err instanceof Error ? err.message : err);
    }
  }, [api, sessionId]);

  return {
    messages: messagesQuery.data ?? [],
    send,
    sending: sendMutation.isPending,
    markRead,
  };
}
