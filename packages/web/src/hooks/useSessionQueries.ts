import { useQuery } from "@tanstack/react-query";
import { api } from "./useApi.js";

export function useSessionsQuery(serverStatus?: string, opts?: { rootsOnly?: boolean }) {
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
  return useQuery({
    queryKey: ["session-children", sessionId],
    queryFn: () => api.getSessionChildren(sessionId!).then((r) => r.sessions),
    enabled: !!sessionId && enabled,
    staleTime: 5000,
  });
}

/**
 * Fetch a session's parent-chain root tree. Used by the detail page's
 * breadcrumb row. 10s staleTime per the spec -- breadcrumbs don't need to
 * track live child adds.
 */
export function useSessionTreeQuery(rootId: string | null) {
  return useQuery({
    queryKey: ["session-tree", rootId],
    queryFn: () => api.getSessionTree(rootId!).then((r) => r.root),
    enabled: !!rootId,
    staleTime: 10_000,
  });
}

export function useGroupsQuery() {
  return useQuery({ queryKey: ["groups"], queryFn: api.getGroups });
}

export function useSessionDetail(id: string | null) {
  return useQuery({
    queryKey: ["session", id],
    queryFn: () => api.getSession(id!),
    enabled: !!id,
  });
}

export function useSessionOutput(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["session-output", id],
    queryFn: () => api.getOutput(id!),
    enabled: !!id && enabled,
    refetchInterval: 2000,
  });
}
