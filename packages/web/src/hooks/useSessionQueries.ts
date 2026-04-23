import { useQuery } from "@tanstack/react-query";
import { useApi } from "./useApi.js";

export function useSessionsQuery(serverStatus?: string) {
  const api = useApi();
  const filters = serverStatus ? { status: serverStatus } : undefined;
  return useQuery({
    queryKey: ["sessions", serverStatus || "default"],
    queryFn: () => api.getSessions(filters),
    refetchInterval: 5000,
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
