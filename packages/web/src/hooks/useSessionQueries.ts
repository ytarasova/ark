import { useQuery } from "@tanstack/react-query";
import { api } from "./useApi.js";

export function useSessionsQuery() {
  return useQuery({ queryKey: ["sessions"], queryFn: api.getSessions });
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
