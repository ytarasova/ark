import { useQuery } from "@tanstack/react-query";
import { useApi } from "./useApi.js";

export function useSessionsQuery(serverStatus?: string, opts?: { rootsOnly?: boolean }) {
  const api = useApi();
  const rootsOnly = opts?.rootsOnly ?? false;
  const filters: Record<string, unknown> = {};
  if (serverStatus) filters.status = serverStatus;
  if (rootsOnly) filters.rootsOnly = true;
  return useQuery({
    queryKey: ["sessions", serverStatus || "default", rootsOnly ? "roots" : "flat"],
    queryFn: () => api.getSessions(filters),
    refetchInterval: 5000,
  });
}

/**
 * Fetch direct children of a parent session. Disabled when `enabled` is false
 * so list rows can lazily call this on expansion. Cached per sessionId so
 * flipping a row closed then open reuses the fetched payload.
 */
export function useSessionChildrenQuery(sessionId: string | null, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: ["session-children", sessionId],
    queryFn: () => api.getSessionChildren(sessionId!).then((r) => r.sessions),
    enabled: !!sessionId && enabled,
    staleTime: 5000,
    // Poll while the parent row is expanded so child rows reflect status
    // transitions (running -> ready -> completed) live. The detail panel
    // already polls per-session on a 5s cadence (useSessionStream); the
    // children list cache was never invalidated on child completion --
    // SSE broadcasts only patch the roots-only cache, not
    // ["session-children", parentId]. Match that 5s rhythm so the side
    // panel doesn't show stale "running" labels long after a child
    // finished.
    refetchInterval: enabled ? 5000 : false,
  });
}

/**
 * Fetch a session's parent-chain root tree. Used by the detail page's
 * breadcrumb row. 10s staleTime per the spec -- breadcrumbs don't need to
 * track live child adds.
 */
export function useSessionTreeQuery(rootId: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: ["session-tree", rootId],
    queryFn: () => api.getSessionTree(rootId!).then((r) => r.root),
    enabled: !!rootId,
    staleTime: 10_000,
  });
}

export function useGroupsQuery() {
  const api = useApi();
  return useQuery({ queryKey: ["groups"], queryFn: api.getGroups });
}

export function useSessionDetail(id: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: ["session", id],
    queryFn: () => api.getSession(id!),
    enabled: !!id,
  });
}

export function useSessionOutput(id: string | null, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: ["session-output", id],
    queryFn: () => api.getOutput(id!),
    enabled: !!id && enabled,
    refetchInterval: 2000,
  });
}

/**
 * Poll the server-aggregated unread-message counts every 10s. Returns a
 * Record<sessionId, number> plus a derived `totalUnread`. Replaces the
 * hand-rolled `setInterval(fetchUnreadCounts, 10_000)` dance in SessionsPage.
 */
export function useUnreadCountsQuery() {
  const api = useApi();
  const query = useQuery({
    queryKey: ["unread-counts"],
    queryFn: api.getUnreadCounts,
    refetchInterval: 10_000,
  });
  const unreadCounts = query.data ?? {};
  let totalUnread = 0;
  for (const v of Object.values(unreadCounts)) totalUnread += v as number;
  return { unreadCounts, totalUnread };
}
